import { createHash } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename, join } from 'node:path';
import { ApiClient } from '../../shared/api';
import { PlatformError } from '../../shared/errors';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { type InboxComment, registerPostPlatform } from '../posting';

// Mastodon REST API with an access token from the user's own instance
// (Preferences > Development > New application). Limits vary per instance and are read
// from /api/v2/instance at publish time. https://docs.joinmastodon.org/methods/statuses/

export const MASTO_ENV = { instance: 'MASTODON_INSTANCE', token: 'MASTODON_ACCESS_TOKEN' } as const;
const DEFAULT_LIMITS = { maxCharacters: 500, maxMedia: 4, reservedPerUrl: 23 };

export function mastodonLength(text: string, reservedPerUrl = 23): number {
  let n = 0;
  const rest = text.replace(/https?:\/\/[^\s]+/g, () => {
    n += reservedPerUrl;
    return '';
  });
  return n + [...rest].length;
}

export function checkMastodonPost(draft: PostDraft, now = Date.now(), limits = DEFAULT_LIMITS): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const text = draft.link ? `${draft.text ?? ''} ${draft.link}`.trim() : (draft.text ?? '');
  if (draft.platform !== 'mastodon') errors.push('platform must be "mastodon"');
  if (!['text', 'media', 'poll'].includes(draft.kind)) errors.push('kind must be text, media or poll');
  if (!text.trim() && media.length === 0) errors.push('text is required');
  if (mastodonLength(text, limits.reservedPerUrl) > limits.maxCharacters) {
    errors.push(
      `text exceeds ${limits.maxCharacters} characters (the instance may allow more; checked again at publish)`,
    );
  }
  if (media.length > limits.maxMedia) errors.push(`at most ${limits.maxMedia} attachments`);
  if (media.some((m) => isRemote(m.source))) errors.push('attachments must be local files');
  if (media.some((m) => !m.altText)) warnings.push('add altText (image descriptions) to every attachment');
  if (draft.kind === 'poll' && media.length > 0) errors.push('polls cannot have media');
  const visibility = draft.options?.visibility ?? 'public';
  if (!['public', 'unlisted', 'private', 'direct'].includes(String(visibility)))
    errors.push('options.visibility must be public, unlisted, private or direct');
  if (draft.scheduledAt && Date.parse(draft.scheduledAt) - now < 5 * 60_000)
    errors.push('scheduledAt must be at least 5 minutes ahead');
  return { ok: errors.length === 0, errors, warnings };
}

export function mastodonClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  const instance = env[MASTO_ENV.instance];
  const token = env[MASTO_ENV.token];
  if (!instance || !token) {
    throw new PlatformError(
      'MASTODON_ENV_MISSING',
      'MASTODON_INSTANCE and MASTODON_ACCESS_TOKEN must be set.',
      'See the socialkit-mastodon-post skill references/setup.md.',
    );
  }
  return new ApiClient({
    base: instance.replace(/\/$/, '').replace(/^(?!https:\/\/)/, 'https://'),
    fetchImpl,
    token: async () => token,
    onError: (status, body) =>
      new PlatformError(
        `MASTODON_${status}`,
        String((body as { error?: string }).error ?? `Mastodon API error ${status}`),
        status === 401 || status === 403
          ? 'The access token is invalid or lacks write:statuses / write:media.'
          : undefined,
      ),
  });
}

export async function publishMastodon(
  client: ApiClient,
  dir: string,
  draft: PostDraft,
  sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
): Promise<Record<string, unknown>> {
  const instance = await client.get<{
    configuration?: {
      statuses?: { max_characters?: number; max_media_attachments?: number; characters_reserved_per_url?: number };
    };
  }>('/api/v2/instance');
  const cfg = instance.body.configuration?.statuses;
  const limits = {
    maxCharacters: cfg?.max_characters ?? DEFAULT_LIMITS.maxCharacters,
    maxMedia: cfg?.max_media_attachments ?? DEFAULT_LIMITS.maxMedia,
    reservedPerUrl: cfg?.characters_reserved_per_url ?? DEFAULT_LIMITS.reservedPerUrl,
  };
  const check = checkMastodonPost(draft, Date.now(), limits);
  if (!check.ok) throw new PlatformError('MASTODON_INVALID', check.errors.join('; '));

  const media_ids: string[] = [];
  for (const m of draft.media ?? []) {
    const form = new FormData();
    form.set('file', await openAsBlob(join(dir, m.source)), basename(m.source));
    if (m.altText) form.set('description', m.altText);
    const up = await client.post<{ id: string; url: string | null }>('/api/v2/media', form);
    let ready = up.status === 200 && Boolean(up.body.url);
    for (let i = 0; !ready && i < 30; i++) {
      await sleep(2_000);
      const st = await client.get<{ url: string | null }>(`/api/v1/media/${up.body.id}`);
      ready = st.status === 200 && Boolean(st.body.url);
    }
    media_ids.push(up.body.id);
  }
  const text = draft.link ? `${draft.text ?? ''} ${draft.link}`.trim() : draft.text;
  const poll = draft.options?.poll as { options: string[]; expiresInSeconds?: number } | undefined;
  // Same folder and content give the same key, so a retried request cannot post twice.
  const idempotency = createHash('sha256')
    .update(`${dir}\n${JSON.stringify(draft)}`)
    .digest('hex');
  const res = await client.post<{ id: string; url?: string; scheduled_at?: string }>(
    '/api/v1/statuses',
    {
      status: text,
      visibility: draft.options?.visibility ?? 'public',
      ...(media_ids.length ? { media_ids } : {}),
      ...(poll ? { poll: { options: poll.options, expires_in: poll.expiresInSeconds ?? 86400 } } : {}),
      ...(draft.options?.spoilerText ? { spoiler_text: draft.options.spoilerText } : {}),
      ...(draft.options?.lang ? { language: draft.options.lang } : {}),
      ...(draft.scheduledAt ? { scheduled_at: draft.scheduledAt } : {}),
    },
    { 'Idempotency-Key': idempotency },
  );
  return { id: res.body.id, url: res.body.url, scheduledAt: res.body.scheduled_at };
}

registerPostPlatform({
  id: 'mastodon',
  label: 'Mastodon',
  kinds: ['text', 'media', 'poll'],
  textLimit: 500,
  scheduling: true,
  notes: [
    'Character limit is per instance (500 by default); links count as 23.',
    'Add alt text to every attachment.',
    'Scheduling needs at least 5 minutes notice.',
  ],
  check: (draft, now) => checkMastodonPost(draft, now),
  publish: (dir, draft, env) => publishMastodon(mastodonClient(env), dir, draft),
  async metrics(postId, env) {
    const s = (await mastodonClient(env).get<Record<string, number>>(`/api/v1/statuses/${postId}`)).body;
    return { favourites: s.favourites_count ?? 0, boosts: s.reblogs_count ?? 0, replies: s.replies_count ?? 0 };
  },
  async comments(postId, env) {
    const ctx = await mastodonClient(env).get<{
      descendants?: Array<{
        id: string;
        in_reply_to_id?: string;
        account?: { acct?: string };
        content?: string;
        created_at?: string;
      }>;
    }>(`/api/v1/statuses/${postId}/context`);
    return (ctx.body.descendants ?? [])
      .filter((d) => d.in_reply_to_id === postId)
      .map(
        (d): InboxComment => ({
          platform: 'mastodon',
          postId,
          commentId: d.id,
          author: d.account?.acct ?? 'unknown',
          text: (d.content ?? '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim(),
          createdAt: d.created_at ?? '',
        }),
      );
  },
  async reply(comment, text, env) {
    const res = await mastodonClient(env).post<{ id: string }>('/api/v1/statuses', {
      status: `@${comment.author} ${text}`,
      in_reply_to_id: comment.commentId,
      visibility: 'public',
    });
    return { id: res.body.id };
  },
});
