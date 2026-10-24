import { isRemote, type PostDraft } from '../../shared/post-project';
import { waitForContainer } from '../meta/containers';
import type { CheckResult } from '../meta/facebook';
import type { GraphClient } from '../meta/graph';

// Threads publishing. Media must be at a public URL; the API has no direct upload.
// https://developers.facebook.com/documentation/threads/posts

export const THREADS_KINDS = ['text', 'image', 'video', 'carousel'] as const;
export const THREADS_LIMITS = {
  textChars: 500,
  links: 5,
  carouselMin: 2,
  carouselMax: 20,
  altText: 1000,
  topicTag: 50,
} as const;

/** Threads counts emoji by their UTF-8 byte length; other characters count as one. */
export function threadsLength(text: string): number {
  let n = 0;
  for (const ch of text) n += /\p{Extended_Pictographic}/u.test(ch) ? Buffer.byteLength(ch) : 1;
  return n;
}

export function uniqueLinks(text: string, attachment?: string): number {
  const links = new Set((text.match(/https?:\/\/[^\s]+/g) ?? []).map((l) => l.replace(/[.,)]+$/, '')));
  if (attachment) links.add(attachment);
  return links.size;
}

export function checkThreadsPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const text = draft.text ?? '';
  const kind = draft.kind as (typeof THREADS_KINDS)[number];
  const topic = draft.options?.topicTag as string | undefined;

  if (draft.platform !== 'threads') errors.push('platform must be "threads"');
  if (!THREADS_KINDS.includes(kind)) errors.push(`kind must be one of ${THREADS_KINDS.join(', ')}`);
  if (draft.scheduledAt) errors.push('the Threads API has no scheduling; remove scheduledAt');
  if (threadsLength(text) > THREADS_LIMITS.textChars)
    errors.push(`text exceeds ${THREADS_LIMITS.textChars} characters`);
  if (kind === 'text' && !text.trim()) errors.push('text posts need text');
  if (uniqueLinks(text, draft.link) > THREADS_LIMITS.links) errors.push(`more than ${THREADS_LIMITS.links} links`);
  if (draft.link && kind !== 'text') errors.push('a link attachment is only allowed on text posts');
  if (kind === 'text' && media.length > 0) errors.push('text posts cannot have media');
  if ((kind === 'image' || kind === 'video') && (media.length !== 1 || media[0]?.type !== kind)) {
    errors.push(`${kind} posts need exactly one ${kind}`);
  }
  if (kind === 'carousel' && (media.length < THREADS_LIMITS.carouselMin || media.length > THREADS_LIMITS.carouselMax)) {
    errors.push(`carousels need ${THREADS_LIMITS.carouselMin} to ${THREADS_LIMITS.carouselMax} items`);
  }
  for (const [i, m] of media.entries()) {
    if (!isRemote(m.source))
      errors.push(`media[${i}]: Threads fetches media from a public https URL; local files are not supported`);
    if (m.altText && m.altText.length > THREADS_LIMITS.altText)
      errors.push(`media[${i}]: altText exceeds 1000 characters`);
  }
  if (topic !== undefined && (topic.length < 1 || topic.length > THREADS_LIMITS.topicTag || /[.&]/.test(topic))) {
    errors.push('options.topicTag must be 1-50 characters without "." or "&"');
  }
  return { ok: errors.length === 0, errors, warnings };
}

export async function threadsQuota(client: GraphClient, userId: string): Promise<{ used: number; total?: number }> {
  const res = (await client.get(`${userId}/threads_publishing_limit`, { fields: 'quota_usage,config' })) as {
    data?: Array<{ quota_usage?: number; config?: { quota_total?: number } }>;
  };
  return { used: res.data?.[0]?.quota_usage ?? 0, total: res.data?.[0]?.config?.quota_total };
}

export async function publishThreads(
  client: GraphClient,
  userId: string,
  draft: PostDraft,
  sleep?: (ms: number) => Promise<void>,
): Promise<{ id: string; permalink?: string }> {
  const media = draft.media ?? [];
  const topic = draft.options?.topicTag as string | undefined;
  const create = async (params: Record<string, string | number | boolean | undefined>) =>
    ((await client.post(`${userId}/threads`, params)) as { id: string }).id;
  const mediaParams = (m: (typeof media)[number]) =>
    m.type === 'image'
      ? { media_type: 'IMAGE', image_url: m.source, alt_text: m.altText }
      : { media_type: 'VIDEO', video_url: m.source, alt_text: m.altText };

  let containerId: string;
  if (draft.kind === 'carousel') {
    const children: string[] = [];
    for (const m of media) children.push(await create({ ...mediaParams(m), is_carousel_item: true }));
    containerId = await create({
      media_type: 'CAROUSEL',
      children: children.join(','),
      text: draft.text,
      topic_tag: topic,
    });
  } else if (draft.kind === 'text') {
    containerId = await create({ media_type: 'TEXT', text: draft.text, link_attachment: draft.link, topic_tag: topic });
  } else {
    containerId = await create({
      ...mediaParams(media[0] as (typeof media)[number]),
      text: draft.text,
      topic_tag: topic,
    });
  }

  // Meta recommends waiting about 30 seconds on average before publishing media containers.
  await waitForContainer(client, containerId, {
    field: 'status',
    sleep,
    firstDelayMs: draft.kind === 'text' ? 1_000 : 30_000,
  });
  const { id } = (await client.post(`${userId}/threads_publish`, { creation_id: containerId })) as { id: string };
  let permalink: string | undefined;
  try {
    permalink = ((await client.get(id, { fields: 'permalink' })) as { permalink?: string }).permalink;
  } catch {
    // Published; permalink lookup is best effort.
  }
  return { id, permalink };
}
