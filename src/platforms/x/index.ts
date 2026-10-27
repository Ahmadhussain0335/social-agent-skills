import { openAsBlob, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ApiClient } from '../../shared/api';
import { PlatformError } from '../../shared/errors';
import {
  accessToken,
  createPkce,
  expiresIn,
  loopbackAuthorize,
  postForm,
  type StoredToken,
  saveToken,
} from '../../shared/oauth';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// X API v2 with OAuth 2.0 PKCE (Native App, public client: no secret).
// https://docs.x.com/resources/fundamentals/authentication/oauth-2-0/authorization-code
// Posting is pay-per-use; prices checked 2026-10-24 at https://docs.x.com/x-api/getting-started/pricing

export const X_ENV = { clientId: 'X_CLIENT_ID', redirectUri: 'X_REDIRECT_URI' } as const;
export const X_DEFAULT_REDIRECT = 'http://127.0.0.1:8765/callback';
export const X_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'media.write', 'offline.access'];
export const X_PRICES = { checkedOn: '2026-10-24', post: 0.015, postWithUrl: 0.2, currency: 'USD' } as const;
const API = 'https://api.x.com';
const URL_PATTERN = /https?:\/\/[^\s]+/g;
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const VIDEO_EXT = new Set(['.mp4', '.mov']);

/** X's weighted count: URLs count 23, CJK and similar wide characters count 2. */
export function xLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(URL_PATTERN, () => {
    n += 23;
    return '';
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0) ?? 0;
    const narrow =
      cp <= 0x10ff ||
      (cp >= 0x2000 && cp <= 0x200d) ||
      (cp >= 0x2010 && cp <= 0x201f) ||
      (cp >= 0x2032 && cp <= 0x2037);
    n += narrow ? 1 : 2;
  }
  return n;
}

export function xCost(draft: PostDraft): number {
  return URL_PATTERN.test(draft.text ?? '') || draft.link ? X_PRICES.postWithUrl : X_PRICES.post;
}

export function checkXPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const text = draft.link ? `${draft.text ?? ''} ${draft.link}`.trim() : (draft.text ?? '');
  if (draft.platform !== 'x') errors.push('platform must be "x"');
  if (!['text', 'media', 'poll'].includes(draft.kind)) errors.push('kind must be text, media or poll');
  if (!text.trim() && media.length === 0) errors.push('text or media is required');
  if (xLength(text) > 280) errors.push(`text is ${xLength(text)} weighted characters; the limit is 280`);
  if (draft.scheduledAt) errors.push('the X API has no scheduling; use socialkit-content-calendar to publish later');
  const images = media.filter((m) => m.type === 'image');
  const videos = media.filter((m) => m.type === 'video');
  if (images.length > 4) errors.push('at most 4 images');
  if (videos.length > 1 || (videos.length === 1 && images.length > 0))
    errors.push('a video must be the only media item');
  for (const m of media) {
    if (isRemote(m.source)) errors.push(`${m.source}: X uploads local files; download the media into the post folder`);
    const ext = extname(m.source).toLowerCase();
    if (m.type === 'image' && !IMAGE_EXT.has(ext)) errors.push(`${m.source}: images must be JPG, PNG, WEBP or GIF`);
    if (m.type === 'video' && !VIDEO_EXT.has(ext)) errors.push(`${m.source}: videos must be MP4 or MOV`);
  }
  const poll = draft.options?.poll as { options?: string[]; durationMinutes?: number } | undefined;
  if (draft.kind === 'poll') {
    if (!poll?.options || poll.options.length < 2 || poll.options.length > 4)
      errors.push('options.poll.options needs 2-4 choices');
    if (poll?.options?.some((o) => o.length < 1 || o.length > 25)) errors.push('poll choices must be 1-25 characters');
    const d = poll?.durationMinutes ?? 1440;
    if (d < 5 || d > 10080) errors.push('options.poll.durationMinutes must be 5-10080');
    if (media.length > 0) errors.push('polls cannot have media');
  }
  if (xCost(draft) === X_PRICES.postWithUrl)
    warnings.push(`this post contains a link, which X prices at $${X_PRICES.postWithUrl} instead of $${X_PRICES.post}`);
  return { ok: errors.length === 0, errors, warnings };
}

function clientId(env: NodeJS.ProcessEnv): string {
  const id = env[X_ENV.clientId];
  if (!id)
    throw new PlatformError(
      'X_ENV_MISSING',
      'X_CLIENT_ID is not set.',
      'See the socialkit-x-post skill references/setup.md.',
    );
  return id;
}

export async function signInX(
  env: NodeJS.ProcessEnv = process.env,
  onUrl?: (url: string) => void,
): Promise<StoredToken> {
  const redirectUri = env[X_ENV.redirectUri] || X_DEFAULT_REDIRECT;
  const pkce = createPkce();
  const { code } = await loopbackAuthorize({
    platform: 'x',
    authorizeUrl: 'https://x.com/i/oauth2/authorize',
    params: { client_id: clientId(env), scope: X_SCOPES.join(' ') },
    redirectUri,
    pkce,
    env,
    onUrl,
  });
  const res = await postForm(`${API}/2/oauth2/token`, {
    code,
    grant_type: 'authorization_code',
    client_id: clientId(env),
    redirect_uri: redirectUri,
    code_verifier: pkce.verifier,
  });
  const token = toToken(res);
  saveToken('x', token, env);
  return token;
}

function toToken(res: Record<string, unknown>, previous?: StoredToken): StoredToken {
  return {
    accessToken: String(res.access_token),
    refreshToken: (res.refresh_token as string | undefined) ?? previous?.refreshToken,
    expiresAt: expiresIn(res.expires_in),
    obtainedAt: new Date().toISOString(),
  };
}

export function xClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  return new ApiClient({
    base: API,
    fetchImpl,
    token: () =>
      accessToken(
        'x',
        async (t) =>
          toToken(
            await postForm(`${API}/2/oauth2/token`, {
              grant_type: 'refresh_token',
              refresh_token: t.refreshToken,
              client_id: clientId(env),
            }),
            t,
          ),
        env,
      ),
    onError: (status, body) => {
      const b = body as { title?: string; detail?: string; type?: string };
      const hint =
        status === 402 || b.type?.includes('usage-capped')
          ? 'Your X API credits are used up. Add credits in the X Developer Console.'
          : status === 403
            ? 'X refused the request: check the app has write access and enough credits, and that the content is not a duplicate.'
            : status === 429
              ? 'Rate limit reached (100 posts per 15 minutes per user). Wait and retry.'
              : undefined;
      return new PlatformError(
        `X_${status}`,
        `${b.title ?? 'X API error'}: ${b.detail ?? JSON.stringify(body).slice(0, 200)}`,
        hint,
      );
    },
  });
}

/** Chunked v2 media upload: initialize, append, finalize, then wait for processing. */
export async function uploadXMedia(
  client: ApiClient,
  path: string,
  type: 'image' | 'video',
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<string> {
  const size = statSync(path).size;
  const ext = extname(path).toLowerCase();
  const mime =
    type === 'video'
      ? ext === '.mov'
        ? 'video/quicktime'
        : 'video/mp4'
      : ext === '.png'
        ? 'image/png'
        : ext === '.gif'
          ? 'image/gif'
          : ext === '.webp'
            ? 'image/webp'
            : 'image/jpeg';
  const category = type === 'video' ? 'tweet_video' : ext === '.gif' ? 'tweet_gif' : 'tweet_image';
  const init = await client.post<{ data?: { id?: string } }>('/2/media/upload/initialize', {
    media_type: mime,
    total_bytes: size,
    media_category: category,
  });
  const id = init.body.data?.id;
  if (!id) throw new PlatformError('X_MEDIA_INIT', 'X did not return a media id.');

  const blob = await openAsBlob(path, { type: mime });
  const chunk = 4 * 1024 * 1024;
  for (let offset = 0, index = 0; offset < size; offset += chunk, index++) {
    const form = new FormData();
    form.set('segment_index', String(index));
    form.set('media', blob.slice(offset, Math.min(size, offset + chunk)));
    await client.post(`/2/media/upload/${id}/append`, form);
  }
  const fin = await client.post<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(
    `/2/media/upload/${id}/finalize`,
  );
  let info = fin.body.data?.processing_info;
  for (let i = 0; info && info.state !== 'succeeded' && i < 60; i++) {
    if (info.state === 'failed') throw new PlatformError('X_MEDIA_FAILED', `X could not process ${path}.`);
    await sleep((info.check_after_secs ?? 5) * 1000);
    info = (
      await client.get<{ data?: { processing_info?: { state?: string; check_after_secs?: number } } }>(
        `/2/media/upload?command=STATUS&media_id=${id}`,
      )
    ).body.data?.processing_info;
  }
  return id;
}

export async function publishX(
  client: ApiClient,
  dir: string,
  draft: PostDraft,
): Promise<{ id: string; url: string; estimatedCost: string }> {
  const media_ids: string[] = [];
  for (const m of draft.media ?? []) media_ids.push(await uploadXMedia(client, join(dir, m.source), m.type));
  const poll = draft.options?.poll as { options: string[]; durationMinutes?: number } | undefined;
  const text = draft.link ? `${draft.text ?? ''} ${draft.link}`.trim() : draft.text;
  const res = await client.post<{ data?: { id?: string } }>('/2/tweets', {
    text,
    ...(media_ids.length ? { media: { media_ids } } : {}),
    ...(draft.kind === 'poll' && poll
      ? { poll: { options: poll.options, duration_minutes: poll.durationMinutes ?? 1440 } }
      : {}),
    ...(draft.options?.madeWithAi ? { made_with_ai: true } : {}),
    ...(draft.options?.paidPartnership ? { paid_partnership: true } : {}),
  });
  const id = res.body.data?.id;
  if (!id) throw new PlatformError('X_NO_ID', 'X returned no post id.');
  return { id, url: `https://x.com/i/web/status/${id}`, estimatedCost: `$${xCost(draft)}` };
}

registerPostPlatform({
  id: 'x',
  label: 'X',
  kinds: ['text', 'media', 'poll'],
  textLimit: 280,
  scheduling: false,
  notes: [
    'Pay-per-use: about $0.015 per post, $0.20 when the post contains a link.',
    'URLs count as 23 characters; up to 4 images or 1 video.',
    'No identical cross-posting and no unsolicited @mentions (X developer guidelines).',
  ],
  check: (draft) => checkXPost(draft),
  approvalNotes: (draft) => [`Estimated X API cost: $${xCost(draft)} (X price list checked ${X_PRICES.checkedOn}).`],
  publish: (dir, draft, env) => publishX(xClient(env), dir, draft),
  async metrics(postId, env) {
    const res = await xClient(env).get<{ data?: { public_metrics?: Record<string, number> } }>(
      `/2/tweets/${postId}?tweet.fields=public_metrics`,
    );
    return res.body.data?.public_metrics ?? {};
  },
});
