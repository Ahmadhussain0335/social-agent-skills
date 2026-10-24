import { extname, join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { GraphClient } from './graph';

// Facebook Page publishing. Pages only: the API cannot post to personal profiles.
// Feed and photos: https://developers.facebook.com/docs/pages-api/posts
// Photos: https://developers.facebook.com/docs/graph-api/reference/page/photos/
// Scheduling window for feed and photo posts: 10 minutes to 30 days ahead.

export const FB_KINDS = ['text', 'link', 'photo', 'photos', 'video'] as const;
const MIN_SCHEDULE_MS = 10 * 60 * 1000;
const MAX_FEED_SCHEDULE_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_VIDEO_SCHEDULE_MS = 180 * 24 * 60 * 60 * 1000;

export interface CheckResult {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

export function checkFacebookPost(draft: PostDraft, now = Date.now()): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const kind = draft.kind as (typeof FB_KINDS)[number];

  if (draft.platform !== 'facebook') errors.push('platform must be "facebook"');
  if (!FB_KINDS.includes(kind)) errors.push(`kind must be one of ${FB_KINDS.join(', ')}`);
  if ((kind === 'text' || kind === 'link') && !draft.text?.trim() && !draft.link)
    errors.push('text or link is required');
  if (kind === 'link' && !draft.link) errors.push('link posts need "link"');
  if (draft.link && !/^https?:\/\//.test(draft.link)) errors.push('link must be an http(s) URL');
  if (kind === 'photo' && (media.length !== 1 || media[0]?.type !== 'image'))
    errors.push('photo posts need exactly one image');
  if (kind === 'photos' && (media.length < 2 || media.some((m) => m.type !== 'image')))
    errors.push('photos posts need two or more images');
  if (kind === 'video' && (media.length !== 1 || media[0]?.type !== 'video'))
    errors.push('video posts need exactly one video');
  if ((kind === 'text' || kind === 'link') && media.length > 0)
    errors.push(`${kind} posts cannot have media; use photo, photos or video`);

  if (draft.scheduledAt) {
    const at = Date.parse(draft.scheduledAt);
    const max = kind === 'video' ? MAX_VIDEO_SCHEDULE_MS : MAX_FEED_SCHEDULE_MS;
    if (Number.isNaN(at)) errors.push('scheduledAt must be an ISO 8601 date');
    else if (at - now < MIN_SCHEDULE_MS) errors.push('scheduledAt must be at least 10 minutes in the future');
    else if (at - now > max) errors.push(`scheduledAt must be within ${kind === 'video' ? '6 months' : '30 days'}`);
  }
  if (media.some((m) => m.altText && m.type === 'video')) warnings.push('altText is only used for images');
  return { ok: errors.length === 0, errors, warnings };
}

export interface PublishResult {
  id: string;
  url?: string;
  scheduledAt?: string;
}

function scheduling(draft: PostDraft): Record<string, string | number | boolean | undefined> {
  if (!draft.scheduledAt) return { published: true };
  return { published: false, scheduled_publish_time: Math.floor(Date.parse(draft.scheduledAt) / 1000) };
}

const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
};

function contentType(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream';
}

async function uploadPhoto(
  client: GraphClient,
  pageId: string,
  dir: string,
  media: NonNullable<PostDraft['media']>[number],
  params: Record<string, string | number | boolean | undefined>,
): Promise<string> {
  const fields = { ...params, alt_text_custom: media.altText };
  const res = (
    isRemote(media.source)
      ? await client.post(`${pageId}/photos`, { ...fields, url: media.source })
      : await client.postFile(`${pageId}/photos`, fields, {
          field: 'source',
          path: join(dir, media.source),
          contentType: contentType(media.source),
        })
  ) as { id?: string; post_id?: string };
  const id = res.post_id ?? res.id;
  if (!id) throw new PlatformError('FB_NO_ID', 'Facebook returned no id for the photo.');
  return id;
}

export async function publishFacebook(
  client: GraphClient,
  pageId: string,
  dir: string,
  draft: PostDraft,
): Promise<PublishResult> {
  const media = draft.media ?? [];
  const schedule = scheduling(draft);
  let id: string;

  switch (draft.kind) {
    case 'photo':
      id = await uploadPhoto(client, pageId, dir, media[0] as (typeof media)[number], {
        caption: draft.text,
        ...schedule,
      });
      break;
    case 'photos': {
      // Upload unpublished photos, then attach them to one feed post.
      const ids: string[] = [];
      for (const m of media) {
        ids.push(
          await uploadPhoto(client, pageId, dir, m, {
            published: false,
            ...(draft.scheduledAt ? { temporary: true } : {}),
          }),
        );
      }
      const attached = Object.fromEntries(
        ids.map((fbid, i) => [`attached_media[${i}]`, JSON.stringify({ media_fbid: fbid })]),
      );
      const res = (await client.post(`${pageId}/feed`, {
        message: draft.text,
        ...attached,
        ...schedule,
        ...(draft.scheduledAt ? { unpublished_content_type: 'SCHEDULED' } : {}),
      })) as { id: string };
      id = res.id;
      break;
    }
    case 'video': {
      const video = media[0] as (typeof media)[number];
      const params = { description: draft.text, title: draft.options?.title as string | undefined, ...schedule };
      const res = (
        isRemote(video.source)
          ? await client.post(`${pageId}/videos`, { ...params, file_url: video.source })
          : await client.postFile(`${pageId}/videos`, params, {
              field: 'source',
              path: join(dir, video.source),
              contentType: contentType(video.source),
            })
      ) as { id: string };
      id = res.id;
      break;
    }
    default: {
      const res = (await client.post(`${pageId}/feed`, { message: draft.text, link: draft.link, ...schedule })) as {
        id: string;
      };
      id = res.id;
    }
  }
  return { id, url: `https://www.facebook.com/${id}`, scheduledAt: draft.scheduledAt };
}
