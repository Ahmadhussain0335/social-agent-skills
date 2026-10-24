import { openAsBlob, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ApiClient } from '../../shared/api';
import { PlatformError } from '../../shared/errors';
import {
  accessToken,
  expiresIn,
  finishPasteback,
  postForm,
  type StoredToken,
  saveToken,
  startPasteback,
} from '../../shared/oauth';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// Pinterest API v5. Trial-access apps create Pins visible only to their creator until the
// app is upgraded to Standard access (demo video review).
// https://developers.pinterest.com/docs/key-concepts/access-tiers/

export const PIN_ENV = {
  appId: 'PINTEREST_APP_ID',
  appSecret: 'PINTEREST_APP_SECRET',
  redirectUri: 'PINTEREST_REDIRECT_URI',
  sandbox: 'PINTEREST_SANDBOX',
} as const;
export const PIN_SCOPES = ['boards:read', 'boards:write', 'pins:read', 'pins:write', 'user_accounts:read'];
export const PIN_LIMITS = {
  title: 100,
  description: 800,
  link: 2048,
  altText: 500,
  carouselMin: 2,
  carouselMax: 5,
} as const;

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v)
    throw new PlatformError(
      'PINTEREST_ENV_MISSING',
      `${name} is not set.`,
      'See the pinterest-post skill references/setup.md.',
    );
  return v;
}

function apiBase(env: NodeJS.ProcessEnv): string {
  return env[PIN_ENV.sandbox] === '1' ? 'https://api-sandbox.pinterest.com/v5' : 'https://api.pinterest.com/v5';
}

function basic(env: NodeJS.ProcessEnv): Record<string, string> {
  return {
    authorization: `Basic ${Buffer.from(`${need(env, PIN_ENV.appId)}:${need(env, PIN_ENV.appSecret)}`).toString('base64')}`,
  };
}

export function startPinterestLogin(env: NodeJS.ProcessEnv = process.env): string {
  return startPasteback({
    platform: 'pinterest',
    authorizeUrl: 'https://www.pinterest.com/oauth/',
    params: { client_id: need(env, PIN_ENV.appId), scope: PIN_SCOPES.join(',') },
    redirectUri: need(env, PIN_ENV.redirectUri),
    env,
  });
}

function toToken(res: Record<string, unknown>, previous?: StoredToken): StoredToken {
  return {
    accessToken: String(res.access_token),
    refreshToken: (res.refresh_token as string | undefined) ?? previous?.refreshToken,
    expiresAt: expiresIn(res.expires_in),
    refreshExpiresAt: expiresIn(res.refresh_token_expires_in) ?? previous?.refreshExpiresAt,
    obtainedAt: new Date().toISOString(),
  };
}

export async function finishPinterestLogin(
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl?: typeof fetch,
): Promise<StoredToken> {
  const { code, redirectUri } = finishPasteback('pinterest', pastedUrl, env);
  const res = await postForm(
    'https://api.pinterest.com/v5/oauth/token',
    { grant_type: 'authorization_code', code, redirect_uri: redirectUri, continuous_refresh: 'true' },
    basic(env),
    fetchImpl,
  );
  const token = toToken(res);
  saveToken('pinterest', token, env);
  return token;
}

export function pinterestClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  return new ApiClient({
    base: apiBase(env),
    fetchImpl,
    token: () =>
      accessToken(
        'pinterest',
        async (t) =>
          toToken(
            await postForm(
              'https://api.pinterest.com/v5/oauth/token',
              { grant_type: 'refresh_token', refresh_token: t.refreshToken },
              basic(env),
            ),
            t,
          ),
        env,
      ),
    onError: (status, body) => {
      const b = body as { message?: string; code?: number };
      const hint =
        status === 403 && /PINNER_DATA_ACCESS_DENIED/.test(JSON.stringify(body))
          ? 'Pinterest restricts apps registered after 2026-09-14 from personal accounts; use a Pinterest business account.'
          : status === 401
            ? 'Sign in to Pinterest again.'
            : undefined;
      return new PlatformError(`PINTEREST_${status}`, b.message ?? `Pinterest API error ${status}`, hint);
    },
  });
}

export function checkPinterestPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  const o = draft.options ?? {};
  if (draft.platform !== 'pinterest') errors.push('platform must be "pinterest"');
  if (!['image', 'carousel', 'video'].includes(draft.kind)) errors.push('kind must be image, carousel or video');
  if (!o.boardId) errors.push('options.boardId is required (list boards with the auth script --boards)');
  if (o.title && String(o.title).length > PIN_LIMITS.title)
    errors.push(`options.title exceeds ${PIN_LIMITS.title} characters`);
  if ((draft.text ?? '').length > PIN_LIMITS.description)
    errors.push(`text (description) exceeds ${PIN_LIMITS.description} characters`);
  if (draft.link && draft.link.length > PIN_LIMITS.link) errors.push('link exceeds 2048 characters');
  if (draft.scheduledAt) errors.push('scheduling is not supported by this skill; use content-calendar');
  if (draft.kind === 'image' && (media.length !== 1 || media[0]?.type !== 'image'))
    errors.push('image pins need exactly one image');
  if (draft.kind === 'carousel' && (media.length < 2 || media.length > 5 || media.some((m) => m.type !== 'image')))
    errors.push('carousels need 2-5 images');
  if (draft.kind === 'video') {
    if (media.length !== 1 || media[0]?.type !== 'video') errors.push('video pins need exactly one video');
    if (media[0] && isRemote(media[0].source)) errors.push('videos are uploaded from a local file');
    if (!o.coverImageUrl) errors.push('options.coverImageUrl (public https image) is required for video pins');
  }
  for (const m of media)
    if (m.altText && m.altText.length > PIN_LIMITS.altText) errors.push(`${m.source}: altText exceeds 500 characters`);
  if (media.some((m) => m.type === 'image' && !m.altText)) warnings.push('add altText to images');
  return { ok: errors.length === 0, errors, warnings };
}

function imageSource(dir: string, source: string): Record<string, string> {
  if (isRemote(source)) return { url: source };
  const ext = extname(source).toLowerCase();
  return {
    content_type: ext === '.png' ? 'image/png' : 'image/jpeg',
    data: readFileSync(join(dir, source)).toString('base64'),
  };
}

export async function publishPinterest(
  client: ApiClient,
  dir: string,
  draft: PostDraft,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ id: string; url: string }> {
  const media = draft.media ?? [];
  const o = draft.options ?? {};
  let media_source: Record<string, unknown>;
  if (draft.kind === 'carousel') {
    const remote = media.every((m) => isRemote(m.source));
    media_source = remote
      ? {
          source_type: 'multiple_image_urls',
          items: media.map((m) => ({
            url: m.source,
            alt_text: m.altText,
            title: o.title,
            description: draft.text,
            link: draft.link,
          })),
        }
      : {
          source_type: 'multiple_image_base64',
          items: media.map((m) => ({ ...imageSource(dir, m.source), alt_text: m.altText })),
        };
  } else if (draft.kind === 'video') {
    const path = join(dir, (media[0] as (typeof media)[number]).source);
    const reg = await client.post<{ media_id: string; upload_url: string; upload_parameters: Record<string, string> }>(
      '/media',
      { media_type: 'video' },
    );
    const form = new FormData();
    for (const [k, v] of Object.entries(reg.body.upload_parameters)) form.set(k, v);
    form.set('file', await openAsBlob(path), 'video.mp4');
    const s3 = await fetch(reg.body.upload_url, { method: 'POST', body: form });
    if (!s3.ok) throw new PlatformError('PINTEREST_UPLOAD', `Video upload failed (HTTP ${s3.status}).`);
    let status = 'registered';
    for (let i = 0; i < 40 && status !== 'succeeded'; i++) {
      await sleep(i === 0 ? 2_000 : 10_000);
      status = (await client.get<{ status: string }>(`/media/${reg.body.media_id}`)).body.status;
      if (status === 'failed')
        throw new PlatformError('PINTEREST_VIDEO_FAILED', 'Pinterest could not process the video.');
    }
    if (status !== 'succeeded')
      throw new PlatformError('PINTEREST_VIDEO_TIMEOUT', 'The video is still processing; nothing was posted.');
    media_source = { source_type: 'video_id', media_id: reg.body.media_id, cover_image_url: o.coverImageUrl };
  } else {
    const m = media[0] as (typeof media)[number];
    const src = imageSource(dir, m.source);
    media_source = src.url ? { source_type: 'image_url', url: src.url } : { source_type: 'image_base64', ...src };
  }
  const res = await client.post<{ id: string }>('/pins', {
    board_id: o.boardId,
    title: o.title,
    description: draft.text,
    link: draft.link,
    alt_text: media[0]?.altText,
    media_source,
  });
  return { id: res.body.id, url: `https://www.pinterest.com/pin/${res.body.id}/` };
}

export async function listBoards(client: ApiClient): Promise<Array<{ id: string; name: string }>> {
  const res = await client.get<{ items?: Array<{ id: string; name: string }> }>('/boards?page_size=100');
  return (res.body.items ?? []).map((b) => ({ id: b.id, name: b.name }));
}

registerPostPlatform({
  id: 'pinterest',
  label: 'Pinterest',
  kinds: ['image', 'carousel', 'video'],
  textLimit: PIN_LIMITS.description,
  scheduling: false,
  notes: [
    'Every Pin needs a board (options.boardId) and benefits from a title (options.title, 100 chars).',
    'Trial-access apps create Pins visible only to you until Standard access is granted.',
    'Images may be local files or https URLs; video Pins need options.coverImageUrl.',
  ],
  check: (draft) => checkPinterestPost(draft),
  publish: (dir, draft, env) => publishPinterest(pinterestClient(env), dir, draft),
  async metrics(postId, env) {
    const end = new Date();
    const start = new Date(end.getTime() - 89 * 24 * 60 * 60 * 1000);
    const day = (d: Date) => d.toISOString().slice(0, 10);
    const res = await pinterestClient(env).get<{
      all?: { lifetime_metrics?: Record<string, number>; summary_metrics?: Record<string, number> };
    }>(
      `/pins/${postId}/analytics?start_date=${day(start)}&end_date=${day(end)}&metric_types=IMPRESSION,SAVE,PIN_CLICK,OUTBOUND_CLICK`,
    );
    return res.body.all?.summary_metrics ?? res.body.all?.lifetime_metrics ?? {};
  },
});
