import { openAsBlob, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { ApiClient } from '../../shared/api';
import { PlatformError } from '../../shared/errors';
import {
  accessToken,
  expiresIn,
  finishPasteback,
  loadToken,
  postForm,
  type StoredToken,
  saveToken,
  startPasteback,
} from '../../shared/oauth';
import { isRemote, type PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// LinkedIn member posting with "Share on LinkedIn" (w_member_social) and OpenID Connect.
// https://learn.microsoft.com/en-us/linkedin/marketing/community-management/shares/posts-api
// Company pages need the Community Management API, which requires a vetted legal entity.
// Self-serve apps get no refresh tokens: access tokens last 60 days, then sign in again.

export const LI_ENV = {
  clientId: 'LINKEDIN_CLIENT_ID',
  clientSecret: 'LINKEDIN_CLIENT_SECRET',
  redirectUri: 'LINKEDIN_REDIRECT_URI',
  version: 'LINKEDIN_VERSION',
} as const;
export const LI_DEFAULT_VERSION = '202610';
export const LI_SCOPES = ['openid', 'profile', 'w_member_social'];
const API = 'https://api.linkedin.com';

function need(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (!v)
    throw new PlatformError(
      'LINKEDIN_ENV_MISSING',
      `${name} is not set.`,
      'See the linkedin-post skill references/setup.md.',
    );
  return v;
}

export function startLinkedInLogin(env: NodeJS.ProcessEnv = process.env): string {
  return startPasteback({
    platform: 'linkedin',
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    params: { client_id: need(env, LI_ENV.clientId), scope: LI_SCOPES.join(' ') },
    redirectUri: need(env, LI_ENV.redirectUri),
    env,
  });
}

export async function finishLinkedInLogin(
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<StoredToken> {
  const { code, redirectUri } = finishPasteback('linkedin', pastedUrl, env);
  const res = await postForm(
    'https://www.linkedin.com/oauth/v2/accessToken',
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: need(env, LI_ENV.clientId),
      client_secret: need(env, LI_ENV.clientSecret),
    },
    {},
    fetchImpl,
  );
  const access = String(res.access_token);
  const me = (await (
    await fetchImpl(`${API}/v2/userinfo`, { headers: { authorization: `Bearer ${access}` } })
  ).json()) as { sub?: string; name?: string };
  if (!me.sub) throw new PlatformError('LINKEDIN_NO_MEMBER', 'LinkedIn did not return the member id.');
  const token: StoredToken = {
    accessToken: access,
    expiresAt: expiresIn(res.expires_in),
    obtainedAt: new Date().toISOString(),
    extra: { personUrn: `urn:li:person:${me.sub}`, name: me.name ?? '' },
  };
  saveToken('linkedin', token, env);
  return token;
}

/** LinkedIn "little text": these characters must be escaped or the post is cut off there. */
export function escapeLittleText(text: string): string {
  return text.replace(/[\\|{}@[\]()<>*_~]/g, (c) => `\\${c}`);
}

export function checkLinkedInPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  if (draft.platform !== 'linkedin') errors.push('platform must be "linkedin"');
  if (!['text', 'link', 'image', 'video'].includes(draft.kind)) errors.push('kind must be text, link, image or video');
  if (!draft.text?.trim()) errors.push('text is required');
  if ([...(draft.text ?? '')].length > 3000) errors.push('text exceeds 3,000 characters');
  if (draft.scheduledAt) errors.push('the LinkedIn API has no scheduling; use content-calendar to publish later');
  if (draft.kind === 'link' && !draft.link) errors.push('link posts need "link"');
  if (draft.kind === 'link' && !draft.options?.title)
    warnings.push('LinkedIn does not fetch link previews via the API; set options.title for the card');
  if (draft.kind === 'image' && (media.length !== 1 || media[0]?.type !== 'image'))
    errors.push('image posts need exactly one image');
  if (draft.kind === 'video' && (media.length !== 1 || media[0]?.type !== 'video'))
    errors.push('video posts need exactly one MP4 video');
  for (const m of media) {
    if (isRemote(m.source))
      errors.push(`${m.source}: LinkedIn uploads local files; download the media into the post folder`);
    if (m.type === 'image' && !['.jpg', '.jpeg', '.png', '.gif'].includes(extname(m.source).toLowerCase()))
      errors.push(`${m.source}: images must be JPG, PNG or GIF`);
    if (m.type === 'video' && extname(m.source).toLowerCase() !== '.mp4') errors.push(`${m.source}: video must be MP4`);
  }
  if (/@\[/.test(draft.text ?? '')) warnings.push('mentions are sent as plain text by this skill');
  return { ok: errors.length === 0, errors, warnings };
}

export function linkedInClient(env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  return new ApiClient({
    base: API,
    fetchImpl,
    token: () => accessToken('linkedin', undefined, env),
    headers: { 'LinkedIn-Version': env[LI_ENV.version] || LI_DEFAULT_VERSION, 'X-Restli-Protocol-Version': '2.0.0' },
    onError: (status, body) => {
      const b = body as { message?: string; code?: string };
      const hint =
        status === 401
          ? 'The LinkedIn sign-in expired (tokens last 60 days). Sign in again.'
          : status === 426 || /version/i.test(b.message ?? '')
            ? 'LinkedIn API version is no longer supported; set LINKEDIN_VERSION to a current YYYYMM version.'
            : status === 403
              ? 'Missing permission: the app needs the "Share on LinkedIn" product (w_member_social).'
              : undefined;
      return new PlatformError(`LINKEDIN_${status}`, b.message ?? `LinkedIn API error ${status}`, hint);
    },
  });
}

async function uploadImage(client: ApiClient, owner: string, path: string): Promise<string> {
  const init = await client.post<{ value: { uploadUrl: string; image: string } }>(
    '/rest/images?action=initializeUpload',
    { initializeUploadRequest: { owner } },
  );
  await client.request('PUT', init.body.value.uploadUrl, await openAsBlob(path));
  return init.body.value.image;
}

async function uploadVideo(
  client: ApiClient,
  owner: string,
  path: string,
  sleep: (ms: number) => Promise<void>,
): Promise<string> {
  const size = statSync(path).size;
  const init = await client.post<{
    value: {
      video: string;
      uploadToken?: string;
      uploadInstructions: Array<{ uploadUrl: string; firstByte: number; lastByte: number }>;
    };
  }>('/rest/videos?action=initializeUpload', {
    initializeUploadRequest: { owner, fileSizeBytes: size, uploadCaptions: false, uploadThumbnail: false },
  });
  const blob = await openAsBlob(path);
  const etags: string[] = [];
  for (const part of init.body.value.uploadInstructions) {
    const res = await client.request('PUT', part.uploadUrl, blob.slice(part.firstByte, part.lastByte + 1));
    etags.push(res.headers.get('etag') ?? '');
  }
  await client.post('/rest/videos?action=finalizeUpload', {
    finalizeUploadRequest: {
      video: init.body.value.video,
      uploadToken: init.body.value.uploadToken ?? '',
      uploadedPartIds: etags,
    },
  });
  const urn = init.body.value.video;
  for (let i = 0; i < 30; i++) {
    const status = await client.get<{ status?: string }>(`/rest/videos/${encodeURIComponent(urn)}`);
    if (status.body.status === 'AVAILABLE') return urn;
    if (status.body.status === 'PROCESSING_FAILED')
      throw new PlatformError('LINKEDIN_VIDEO_FAILED', 'LinkedIn could not process the video.');
    await sleep(10_000);
  }
  throw new PlatformError(
    'LINKEDIN_VIDEO_TIMEOUT',
    'The video is still processing; nothing was posted. Try publishing again later.',
  );
}

export async function publishLinkedIn(
  client: ApiClient,
  author: string,
  dir: string,
  draft: PostDraft,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<{ id: string; url: string }> {
  const media = draft.media?.[0];
  let content: Record<string, unknown> | undefined;
  if (draft.kind === 'image' && media)
    content = { media: { id: await uploadImage(client, author, join(dir, media.source)), altText: media.altText } };
  if (draft.kind === 'video' && media)
    content = {
      media: { id: await uploadVideo(client, author, join(dir, media.source), sleep), title: draft.options?.title },
    };
  if (draft.kind === 'link' && draft.link) {
    content = {
      article: {
        source: draft.link,
        title: draft.options?.title ?? draft.link,
        description: draft.options?.description,
      },
    };
  }
  const res = await client.post('/rest/posts', {
    author,
    commentary: escapeLittleText(draft.text ?? ''),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    ...(content ? { content } : {}),
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  });
  const id = res.headers.get('x-restli-id') ?? '';
  return { id, url: `https://www.linkedin.com/feed/update/${id}/` };
}

registerPostPlatform({
  id: 'linkedin',
  label: 'LinkedIn (personal profile)',
  kinds: ['text', 'link', 'image', 'video'],
  textLimit: 3000,
  scheduling: false,
  notes: [
    'Posts to your personal profile. Company pages need the Community Management API (vetted organisation).',
    'Link previews are not fetched by the API; set options.title for the card.',
    'Sign-in lasts 60 days; there is no refresh for self-serve apps.',
  ],
  check: (draft) => checkLinkedInPost(draft),
  async publish(dir, draft, env) {
    const token = loadToken('linkedin', env);
    const author = (draft.options?.organizationUrn as string | undefined) ?? token.extra?.personUrn;
    if (!author) throw new PlatformError('LINKEDIN_NO_MEMBER', 'Sign in to LinkedIn again; the member id is missing.');
    return publishLinkedIn(linkedInClient(env), author, dir, draft);
  },
});
