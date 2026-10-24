import { openAsBlob, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { fetchWithRetry } from '../../shared/http';
import { isRemote, type PostDraft } from '../../shared/post-project';
import { waitForContainer } from './containers';
import type { CheckResult } from './facebook';
import type { GraphClient } from './graph';

// Instagram publishing through Facebook Login (professional accounts linked to a Page).
// https://developers.facebook.com/docs/instagram-platform/content-publishing
// Images must be JPEG at a public URL; Reels and story videos can be uploaded from a local
// file with the resumable upload, which is available to Facebook Login apps only.

export const IG_KINDS = ['image', 'carousel', 'reel', 'story'] as const;
export const IG_LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  mentions: 20,
  altText: 1000,
  carouselMin: 2,
  carouselMax: 10,
} as const;

export function checkInstagramPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const text = draft.text ?? '';
  const kind = draft.kind as (typeof IG_KINDS)[number];

  if (draft.platform !== 'instagram') errors.push('platform must be "instagram"');
  if (!IG_KINDS.includes(kind)) errors.push(`kind must be one of ${IG_KINDS.join(', ')}`);
  if (draft.scheduledAt)
    errors.push('Instagram API publishing has no scheduling; remove scheduledAt and publish at the chosen time');
  if (draft.link) warnings.push('links in Instagram captions are not clickable; "link" is ignored');
  if ([...text].length > IG_LIMITS.captionChars) errors.push(`caption exceeds ${IG_LIMITS.captionChars} characters`);
  if ((text.match(/#[\p{L}\p{N}_]+/gu) ?? []).length > IG_LIMITS.hashtags)
    errors.push(`more than ${IG_LIMITS.hashtags} hashtags`);
  if ((text.match(/@[\w.]+/g) ?? []).length > IG_LIMITS.mentions)
    errors.push(`more than ${IG_LIMITS.mentions} @mentions`);

  if (kind === 'image' && media.length !== 1) errors.push('image posts need exactly one image');
  if (kind === 'reel' && (media.length !== 1 || media[0]?.type !== 'video'))
    errors.push('reels need exactly one video');
  if (kind === 'story' && media.length !== 1) errors.push('stories need exactly one image or video');
  if (kind === 'carousel' && (media.length < IG_LIMITS.carouselMin || media.length > IG_LIMITS.carouselMax)) {
    errors.push(`carousels need ${IG_LIMITS.carouselMin} to ${IG_LIMITS.carouselMax} items`);
  }

  for (const [i, m] of media.entries()) {
    const label = `media[${i}] (${m.source})`;
    if (m.type === 'image') {
      if (!isRemote(m.source)) {
        errors.push(`${label}: Instagram fetches images from a public https URL; host the JPEG and use its URL`);
      } else if (!/\.jpe?g(\?|$)/i.test(m.source)) {
        warnings.push(`${label}: Instagram accepts JPEG images only; make sure the URL serves a JPEG`);
      }
      if (m.altText && m.altText.length > IG_LIMITS.altText)
        errors.push(`${label}: altText exceeds ${IG_LIMITS.altText} characters`);
    } else if (m.type === 'video') {
      if (kind === 'carousel' && !isRemote(m.source))
        errors.push(`${label}: carousel videos must be public https URLs`);
      if (!isRemote(m.source) && !['.mp4', '.mov'].includes(extname(m.source).toLowerCase())) {
        errors.push(`${label}: videos must be MP4 or MOV`);
      }
      if (m.altText) warnings.push(`${label}: altText applies to images only`);
    }
  }
  return { ok: errors.length === 0, errors, warnings };
}

export interface PublishLimit {
  used: number;
  total?: number;
}

export async function publishingLimit(client: GraphClient, igUserId: string): Promise<PublishLimit> {
  const res = (await client.get(`${igUserId}/content_publishing_limit`, { fields: 'config,quota_usage' })) as {
    data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
  };
  const entry = res.data?.[0];
  return { used: entry?.quota_usage ?? 0, total: entry?.config?.quota_total };
}

interface PublishDeps {
  client: GraphClient;
  igUserId: string;
  accessToken: string;
  graphVersion: string;
  dir: string;
  sleep?: (ms: number) => Promise<void>;
  fetchImpl?: typeof fetch;
}

async function createContainer(
  deps: PublishDeps,
  media: NonNullable<PostDraft['media']>[number],
  params: Record<string, string | number | boolean | undefined>,
  mediaType?: string,
): Promise<string> {
  const local = !isRemote(media.source);
  const fields: Record<string, string | number | boolean | undefined> = { ...params, media_type: mediaType };
  if (media.type === 'image') {
    fields.image_url = media.source;
    fields.alt_text = media.altText;
  } else if (local) {
    fields.upload_type = 'resumable';
  } else {
    fields.video_url = media.source;
  }
  const { id } = (await deps.client.post(`${deps.igUserId}/media`, fields)) as { id: string };
  if (media.type === 'video' && local) await resumableUpload(deps, id, join(deps.dir, media.source));
  return id;
}

/** https://developers.facebook.com/docs/instagram-platform/content-publishing (resumable upload) */
async function resumableUpload(deps: PublishDeps, containerId: string, path: string): Promise<void> {
  const size = statSync(path).size;
  const res = await fetchWithRetry(
    `https://rupload.facebook.com/ig-api-upload/${deps.graphVersion}/${containerId}`,
    {
      method: 'POST',
      headers: { Authorization: `OAuth ${deps.accessToken}`, offset: '0', file_size: String(size) },
      body: await openAsBlob(path),
    },
    { retryOn: [429], fetchImpl: deps.fetchImpl },
  );
  if (!res.ok) {
    throw new PlatformError(
      'IG_UPLOAD_FAILED',
      `Video upload failed (HTTP ${res.status}): ${(await res.text()).slice(0, 300)}`,
    );
  }
}

export async function publishInstagram(
  deps: PublishDeps,
  draft: PostDraft,
): Promise<{ id: string; permalink?: string }> {
  const media = draft.media ?? [];
  const caption = draft.text;
  const wait = (id: string) => waitForContainer(deps.client, id, { field: 'status_code', sleep: deps.sleep });
  let containerId: string;

  switch (draft.kind) {
    case 'carousel': {
      const children: string[] = [];
      for (const m of media) {
        children.push(
          await createContainer(deps, m, { is_carousel_item: true }, m.type === 'video' ? 'VIDEO' : undefined),
        );
      }
      for (const child of children) await wait(child);
      containerId = (
        (await deps.client.post(`${deps.igUserId}/media`, {
          media_type: 'CAROUSEL',
          children: children.join(','),
          caption,
        })) as {
          id: string;
        }
      ).id;
      break;
    }
    case 'reel':
      containerId = await createContainer(
        deps,
        media[0] as (typeof media)[number],
        { caption, share_to_feed: true },
        'REELS',
      );
      break;
    case 'story':
      containerId = await createContainer(deps, media[0] as (typeof media)[number], {}, 'STORIES');
      break;
    default:
      containerId = await createContainer(deps, media[0] as (typeof media)[number], { caption });
  }

  await wait(containerId);
  const { id } = (await deps.client.post(`${deps.igUserId}/media_publish`, { creation_id: containerId })) as {
    id: string;
  };
  let permalink: string | undefined;
  try {
    permalink = ((await deps.client.get(id, { fields: 'permalink' })) as { permalink?: string }).permalink;
  } catch {
    // The post is live; a missing permalink is not worth failing over.
  }
  return { id, permalink };
}

/** Instagram error subcodes that need a specific explanation. */
export function instagramHint(subcode?: number): string | undefined {
  switch (subcode) {
    case 2207052:
      return 'Instagram could not fetch the media URL. It must be publicly reachable over https without login.';
    case 2207042:
      return 'Daily Instagram publishing limit reached for this account. Try again after 24 hours.';
    case 2207004:
      return 'Image is larger than 8 MB.';
    case 2207005:
      return 'Image format not supported; Instagram accepts JPEG only.';
    case 2207009:
      return 'Aspect ratio out of range: images must be between 4:5 and 1.91:1.';
    case 2207010:
      return 'Caption exceeds limits (2,200 characters, 30 hashtags, 20 mentions).';
    case 2207026:
      return 'Video format not supported: use MP4 or MOV with H.264 or HEVC.';
    case 2207050:
      return 'The Instagram account is restricted. Check it in the Instagram app.';
    case 2207051:
      return 'Instagram flagged this action as spam. Do not retry automatically.';
    default:
      return undefined;
  }
}
