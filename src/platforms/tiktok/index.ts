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

// TikTok Content Posting API. Apps owned by one user cannot pass TikTok's audit ("must not
// be for private or personal use"), so direct posts stay SELF_ONLY. The default mode is
// "draft": the video lands in the creator's TikTok inbox and they finish posting in the app.
// https://developers.tiktok.com/doc/content-sharing-guidelines
// https://developers.tiktok.com/doc/content-posting-api-reference-direct-post

export const TT_ENV = {
  clientKey: 'TIKTOK_CLIENT_KEY',
  clientSecret: 'TIKTOK_CLIENT_SECRET',
  redirectUri: 'TIKTOK_REDIRECT_URI',
} as const;
export const TT_DEFAULT_REDIRECT = 'http://127.0.0.1:8766/callback/';
export const TT_SCOPES = ['user.info.basic', 'video.upload', 'video.publish'];
const API = 'https://open.tiktokapis.com';
const MIN_CHUNK = 5 * 1024 * 1024;
const CHUNK = 10 * 1024 * 1024;

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v)
    throw new PlatformError(
      'TIKTOK_ENV_MISSING',
      `${name} is not set.`,
      'See the socialkit-tiktok-post skill references/setup.md.',
    );
  return v;
}

function toToken(res: Record<string, unknown>): StoredToken {
  return {
    accessToken: String(res.access_token),
    // TikTok may rotate the refresh token; always keep the newest one.
    refreshToken: res.refresh_token as string | undefined,
    expiresAt: expiresIn(res.expires_in),
    refreshExpiresAt: expiresIn(res.refresh_expires_in),
    obtainedAt: new Date().toISOString(),
    extra: { openId: String(res.open_id ?? '') },
  };
}

export async function signInTikTok(
  env: NodeJS.ProcessEnv = process.env,
  onUrl?: (url: string) => void,
): Promise<StoredToken> {
  const redirectUri = env[TT_ENV.redirectUri] || TT_DEFAULT_REDIRECT;
  // TikTok's desktop flow uses a hex-encoded SHA-256 code challenge.
  const pkce = createPkce('hex');
  const { code } = await loopbackAuthorize({
    platform: 'tiktok',
    authorizeUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    params: { client_key: need(env, TT_ENV.clientKey), scope: TT_SCOPES.join(',') },
    redirectUri,
    pkce,
    env,
    onUrl,
  });
  const res = await postForm(`${API}/v2/oauth/token/`, {
    client_key: need(env, TT_ENV.clientKey),
    client_secret: need(env, TT_ENV.clientSecret),
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: pkce.verifier,
  });
  const token = toToken(res);
  saveToken('tiktok', token, env);
  return token;
}

export function tiktokClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  return new ApiClient({
    base: API,
    fetchImpl,
    token: () =>
      accessToken(
        'tiktok',
        async (t) =>
          toToken(
            await postForm(`${API}/v2/oauth/token/`, {
              client_key: need(env, TT_ENV.clientKey),
              client_secret: need(env, TT_ENV.clientSecret),
              grant_type: 'refresh_token',
              refresh_token: t.refreshToken,
            }),
          ),
        env,
      ),
    onError: (status, body) => {
      const code = (body as { error?: { code?: string; message?: string } }).error?.code ?? '';
      const hints: Record<string, string> = {
        unaudited_client_can_only_post_to_private_accounts:
          'Unaudited apps can only direct-post to private accounts; use draft mode or make the account private.',
        spam_risk_too_many_posts: 'TikTok daily posting cap reached for this account (about 15 per day). Try tomorrow.',
        reached_active_user_cap: 'Unaudited apps allow at most 5 posting users per 24 hours.',
        privacy_level_option_mismatch: 'options.privacyLevel is not one the creator can use; run --creator-info again.',
        url_ownership_unverified: 'Pulling from a URL needs a verified domain in the TikTok developer portal.',
        access_token_invalid: 'Sign in to TikTok again.',
        scope_not_authorized: 'The app is not approved for this scope (video.upload or video.publish).',
      };
      return new PlatformError(
        `TIKTOK_${status}`,
        `${code || 'TikTok API error'}: ${(body as { error?: { message?: string } }).error?.message ?? ''}`,
        hints[code],
      );
    },
  });
}

export interface CreatorInfo {
  creator_nickname: string;
  privacy_level_options: string[];
  comment_disabled: boolean;
  duet_disabled: boolean;
  stitch_disabled: boolean;
  max_video_post_duration_sec: number;
}

export async function creatorInfo(client: ApiClient): Promise<CreatorInfo> {
  const res = await client.post<{ data: CreatorInfo }>('/v2/post/publish/creator_info/query/', {});
  return res.body.data;
}

export function checkTikTokPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const o = draft.options ?? {};
  const media = draft.media ?? [];
  const mode = (o.mode as string | undefined) ?? 'draft';
  if (draft.platform !== 'tiktok') errors.push('platform must be "tiktok"');
  if (draft.kind !== 'video')
    errors.push('kind must be "video" (photo posts need a verified URL domain and are not supported here)');
  if (media.length !== 1 || media[0]?.type !== 'video') errors.push('exactly one video is required');
  if (media[0] && isRemote(media[0].source))
    errors.push('upload a local video file; pulling from a URL needs a verified domain');
  if (media[0] && !['.mp4', '.mov', '.webm'].includes(extname(media[0].source).toLowerCase()))
    errors.push('video must be MP4, MOV or WebM');
  if (draft.scheduledAt) errors.push('TikTok has no API scheduling; use socialkit-content-calendar');
  if (!['draft', 'direct'].includes(mode)) errors.push('options.mode must be "draft" or "direct"');
  if (mode === 'direct') {
    // Content Sharing Guidelines: privacy must be chosen by the user, interactions off unless chosen.
    if (!o.privacyLevel)
      errors.push('direct mode needs options.privacyLevel chosen by the user from --creator-info (no default)');
    if (!o.creatorNickname)
      errors.push('direct mode needs options.creatorNickname from --creator-info, shown to the user at approval');
    for (const k of ['allowComment', 'allowDuet', 'allowStitch']) {
      if (typeof o[k] !== 'boolean')
        errors.push(`direct mode needs options.${k} set explicitly by the user (true or false)`);
    }
    if (o.brandedContent && o.privacyLevel === 'SELF_ONLY')
      errors.push('branded content cannot be private (TikTok rule)');
    if ([...(draft.text ?? '')].length > 2200) errors.push('title exceeds 2,200 characters');
    warnings.push('apps owned by one user stay unaudited: direct posts are visible only to you (SELF_ONLY)');
  }
  return { ok: errors.length === 0, errors, warnings };
}

async function uploadChunks(
  client: ApiClient,
  uploadUrl: string,
  path: string,
  size: number,
  chunkSize: number,
): Promise<void> {
  const blob = await openAsBlob(path);
  const count = size < MIN_CHUNK ? 1 : Math.floor(size / chunkSize);
  for (let i = 0; i < count; i++) {
    const start = i * chunkSize;
    const end = i === count - 1 ? size - 1 : start + chunkSize - 1;
    await client.request('PUT', uploadUrl, blob.slice(start, end + 1), {
      'content-type':
        extname(path).toLowerCase() === '.mov'
          ? 'video/quicktime'
          : extname(path).toLowerCase() === '.webm'
            ? 'video/webm'
            : 'video/mp4',
      'content-range': `bytes ${start}-${end}/${size}`,
    });
  }
}

export async function publishTikTok(
  client: ApiClient,
  dir: string,
  draft: PostDraft,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<Record<string, unknown>> {
  const o = draft.options ?? {};
  const video = draft.media?.[0];
  if (!video) throw new PlatformError('TIKTOK_NO_VIDEO', 'post.json has no video.');
  const path = join(dir, video.source);
  const size = statSync(path).size;
  const chunkSize = size < MIN_CHUNK ? size : CHUNK;
  const source_info = {
    source: 'FILE_UPLOAD',
    video_size: size,
    chunk_size: chunkSize,
    total_chunk_count: size < MIN_CHUNK ? 1 : Math.floor(size / chunkSize),
  };
  const direct = o.mode === 'direct';

  if (direct) {
    const info = await creatorInfo(client);
    if (!info.privacy_level_options.includes(String(o.privacyLevel))) {
      throw new PlatformError(
        'TIKTOK_PRIVACY',
        `privacyLevel ${o.privacyLevel} is not available; options: ${info.privacy_level_options.join(', ')}`,
      );
    }
  }
  const init = await client.post<{ data: { publish_id: string; upload_url: string } }>(
    direct ? '/v2/post/publish/video/init/' : '/v2/post/publish/inbox/video/init/',
    direct
      ? {
          post_info: {
            title: draft.text,
            privacy_level: o.privacyLevel,
            disable_comment: !o.allowComment,
            disable_duet: !o.allowDuet,
            disable_stitch: !o.allowStitch,
            brand_content_toggle: Boolean(o.brandedContent),
            brand_organic_toggle: Boolean(o.yourBrand),
            is_aigc: Boolean(o.aiGenerated),
          },
          source_info,
        }
      : { source_info },
  );
  await uploadChunks(client, init.body.data.upload_url, path, size, chunkSize);

  const publishId = init.body.data.publish_id;
  let status = 'PROCESSING_UPLOAD';
  let detail: Record<string, unknown> = {};
  for (let i = 0; i < 30 && /^PROCESSING/.test(status); i++) {
    await sleep(5_000);
    detail = (
      await client.post<{ data: Record<string, unknown> }>('/v2/post/publish/status/fetch/', { publish_id: publishId })
    ).body.data;
    status = String(detail.status);
  }
  if (status === 'FAILED')
    throw new PlatformError('TIKTOK_FAILED', `TikTok could not publish: ${detail.fail_reason ?? 'unknown reason'}`);
  return {
    id: publishId,
    status,
    mode: direct ? 'direct' : 'draft',
    next: direct
      ? 'Processing can take a few minutes.'
      : 'Open TikTok: the video is in your inbox notifications to edit and post.',
  };
}

registerPostPlatform({
  id: 'tiktok',
  label: 'TikTok',
  kinds: ['video'],
  textLimit: 2200,
  scheduling: false,
  notes: [
    'Default "draft" mode sends the video to your TikTok inbox; you post it in the app.',
    'Direct mode from your own (unaudited) app is private (SELF_ONLY) and needs explicit privacy and interaction choices.',
    'TikTok allows about 15 posts per day per account across all apps.',
  ],
  check: (draft) => checkTikTokPost(draft),
  approvalNotes: (draft) =>
    draft.options?.mode === 'direct'
      ? [
          `Posting as ${draft.options?.creatorNickname} with privacy ${draft.options?.privacyLevel}.`,
          draft.options?.brandedContent
            ? "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation."
            : "By posting, you agree to TikTok's Music Usage Confirmation.",
        ]
      : ['Draft mode: the video goes to your TikTok inbox; nothing is public until you post it in the app.'],
  publish: (dir, draft, env) => publishTikTok(tiktokClient(env), dir, draft),
});
