import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { fetchWithRetry } from '../../shared/http';
import { isRemote, type PostDraft } from '../../shared/post-project';
import { readSecretJson, writeSecretJson } from '../../shared/token-store';
import type { CheckResult } from '../meta/facebook';
import { type InboxComment, registerPostPlatform } from '../posting';

// Bluesky via AT Protocol with an app password, which Bluesky allows for single-purpose
// command-line tools (https://bsky.network/docs/oauth-client). Sessions are cached because
// createSession is limited to 30 per 5 minutes per account.
// Post lexicon: 300 graphemes; images up to 4, 2,000,000 bytes each, alt text required.

export const BSKY_ENV = {
  handle: 'BLUESKY_HANDLE',
  appPassword: 'BLUESKY_APP_PASSWORD',
  service: 'BLUESKY_SERVICE',
} as const;
const APPVIEW = 'https://public.api.bsky.app';
const MAX_IMAGE_BYTES = 2_000_000;

interface Session {
  did: string;
  handle: string;
  accessJwt: string;
  refreshJwt: string;
  service: string;
}

export function graphemes(text: string): number {
  return [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)].length;
}

export interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<Record<string, string>>;
}

/** Link and hashtag facets with UTF-8 byte offsets, as the post lexicon requires. */
export function detectFacets(text: string): Facet[] {
  const facets: Facet[] = [];
  const byteAt = (i: number) => Buffer.byteLength(text.slice(0, i));
  for (const m of text.matchAll(/https?:\/\/[^\s)]+[^\s).,!?:;'"]/g)) {
    const start = m.index ?? 0;
    facets.push({
      index: { byteStart: byteAt(start), byteEnd: byteAt(start + m[0].length) },
      features: [{ $type: 'app.bsky.richtext.facet#link', uri: m[0] }],
    });
  }
  for (const m of text.matchAll(/(^|\s)#([\p{L}\p{N}_]{1,64})/gu)) {
    const start = (m.index ?? 0) + (m[1] as string).length;
    const tag = m[2] as string;
    if (/^\d+$/.test(tag)) continue;
    facets.push({
      index: { byteStart: byteAt(start), byteEnd: byteAt(start + tag.length + 1) },
      features: [{ $type: 'app.bsky.richtext.facet#tag', tag }],
    });
  }
  return facets.sort((a, b) => a.index.byteStart - b.index.byteStart);
}

export function checkBlueskyPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const media = draft.media ?? [];
  if (draft.platform !== 'bluesky') errors.push('platform must be "bluesky"');
  if (!['text', 'images', 'link'].includes(draft.kind))
    errors.push('kind must be text, images or link (video is not supported yet)');
  if (!(draft.text ?? '').trim() && media.length === 0) errors.push('text is required');
  if (graphemes(draft.text ?? '') > 300)
    errors.push(`text is ${graphemes(draft.text ?? '')} characters; the limit is 300`);
  if (Buffer.byteLength(draft.text ?? '') > 3000) errors.push('text exceeds 3,000 bytes');
  if (draft.scheduledAt) errors.push('Bluesky has no scheduling; use socialkit-content-calendar');
  if (draft.kind === 'images' && (media.length < 1 || media.length > 4 || media.some((m) => m.type !== 'image')))
    errors.push('1 to 4 images');
  if (draft.kind === 'link' && (!draft.link || !draft.options?.title))
    errors.push('link cards need "link" and options.title');
  for (const m of media) {
    if (isRemote(m.source)) errors.push(`${m.source}: upload local image files`);
    if (!m.altText) errors.push(`${m.source}: alt text is required on Bluesky`);
    if (!['.jpg', '.jpeg', '.png', '.webp'].includes(extname(m.source).toLowerCase()))
      errors.push(`${m.source}: images must be JPG, PNG or WEBP`);
  }
  if (/@[\w.-]+\.[a-z]{2,}/i.test(draft.text ?? '')) warnings.push('@mentions are posted as plain text by this skill');
  return { ok: errors.length === 0, errors, warnings };
}

type FetchLike = typeof fetch;

async function xrpc<T>(
  service: string,
  nsid: string,
  init: { method?: string; token?: string; body?: unknown; raw?: Blob; contentType?: string },
  fetchImpl?: FetchLike,
): Promise<T> {
  const headers: Record<string, string> = {};
  if (init.token) headers.authorization = `Bearer ${init.token}`;
  let body: RequestInit['body'];
  if (init.raw) {
    body = init.raw;
    headers['content-type'] = init.contentType ?? 'application/octet-stream';
  } else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers['content-type'] = 'application/json';
  }
  const res = await fetchWithRetry(
    `${service}/xrpc/${nsid}`,
    { method: init.method ?? (body ? 'POST' : 'GET'), headers, body },
    { retryOn: init.method === 'GET' || !body ? undefined : [429], fetchImpl },
  );
  const json = (await res.json().catch(() => ({}))) as T & { error?: string; message?: string };
  if (!res.ok) {
    throw new PlatformError(
      `BLUESKY_${json.error ?? res.status}`,
      json.message ?? `Bluesky request ${nsid} failed (HTTP ${res.status})`,
      json.error === 'AuthenticationRequired' || res.status === 401
        ? 'Check BLUESKY_HANDLE and BLUESKY_APP_PASSWORD (an app password, not your account password).'
        : undefined,
    );
  }
  return json;
}

function sessionPath(env: NodeJS.ProcessEnv): string {
  return join(platformDir('bluesky', env), 'session.json');
}

export async function blueskySession(env: NodeJS.ProcessEnv = process.env, fetchImpl?: FetchLike): Promise<Session> {
  const service = env[BSKY_ENV.service] || 'https://bsky.social';
  const cached = readSecretJson<Session>(sessionPath(env));
  if (cached?.refreshJwt) {
    try {
      const fresh = await xrpc<Session>(
        cached.service,
        'com.atproto.server.refreshSession',
        { method: 'POST', token: cached.refreshJwt },
        fetchImpl,
      );
      const session = { ...cached, ...fresh, service: cached.service };
      writeSecretJson(sessionPath(env), session);
      return session;
    } catch {
      // fall back to a new session
    }
  }
  const identifier = env[BSKY_ENV.handle];
  const password = env[BSKY_ENV.appPassword];
  if (!identifier || !password) {
    throw new PlatformError(
      'BLUESKY_ENV_MISSING',
      'BLUESKY_HANDLE and BLUESKY_APP_PASSWORD must be set.',
      'Create an app password in Bluesky Settings > Privacy and security > App passwords.',
    );
  }
  const created = await xrpc<Session>(
    service,
    'com.atproto.server.createSession',
    { body: { identifier, password } },
    fetchImpl,
  );
  const session = { ...created, service };
  writeSecretJson(sessionPath(env), session);
  return session;
}

export async function publishBluesky(
  dir: string,
  draft: PostDraft,
  env: NodeJS.ProcessEnv,
  fetchImpl?: FetchLike,
): Promise<Record<string, unknown>> {
  const s = await blueskySession(env, fetchImpl);
  let embed: Record<string, unknown> | undefined;
  if (draft.kind === 'images') {
    const images = [];
    for (const m of draft.media ?? []) {
      const path = join(dir, m.source);
      if (statSync(path).size > MAX_IMAGE_BYTES)
        throw new PlatformError('BLUESKY_IMAGE_SIZE', `${m.source} is larger than 2 MB; resize it.`);
      const ext = extname(path).toLowerCase();
      const type = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
      const { blob } = await xrpc<{ blob: unknown }>(
        s.service,
        'com.atproto.repo.uploadBlob',
        { token: s.accessJwt, raw: new Blob([readFileSync(path)]), contentType: type },
        fetchImpl,
      );
      images.push({ image: blob, alt: m.altText ?? '' });
    }
    embed = { $type: 'app.bsky.embed.images', images };
  } else if (draft.kind === 'link' && draft.link) {
    embed = {
      $type: 'app.bsky.embed.external',
      external: {
        uri: draft.link,
        title: String(draft.options?.title ?? ''),
        description: String(draft.options?.description ?? ''),
      },
    };
  }
  const text = draft.text ?? '';
  const facets = detectFacets(text);
  const record = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
    langs: [(draft.options?.lang as string | undefined) ?? 'en'],
    ...(facets.length ? { facets } : {}),
    ...(embed ? { embed } : {}),
  };
  const res = await xrpc<{ uri: string; cid: string }>(
    s.service,
    'com.atproto.repo.createRecord',
    { token: s.accessJwt, body: { repo: s.did, collection: 'app.bsky.feed.post', record } },
    fetchImpl,
  );
  const rkey = res.uri.split('/').pop();
  return { id: res.uri, cid: res.cid, url: `https://bsky.app/profile/${s.handle}/post/${rkey}` };
}

interface ThreadPost {
  post: { uri: string; cid: string; author: { handle: string }; record: { text?: string; createdAt?: string } };
  replies?: ThreadPost[];
}

registerPostPlatform({
  id: 'bluesky',
  label: 'Bluesky',
  kinds: ['text', 'images', 'link'],
  textLimit: 300,
  scheduling: false,
  notes: [
    '300 characters (graphemes).',
    'Alt text is required on every image; images up to 2 MB.',
    'Links and #hashtags become clickable automatically.',
  ],
  check: (draft) => checkBlueskyPost(draft),
  publish: (dir, draft, env) => publishBluesky(dir, draft, env),
  async metrics(postId) {
    const res = await xrpc<{ posts?: Array<Record<string, number>> }>(
      APPVIEW,
      `app.bsky.feed.getPosts?uris=${encodeURIComponent(postId)}`,
      { method: 'GET' },
    );
    const p = res.posts?.[0] ?? {};
    return {
      likes: p.likeCount ?? 0,
      reposts: p.repostCount ?? 0,
      replies: p.replyCount ?? 0,
      quotes: p.quoteCount ?? 0,
    };
  },
  async comments(postId) {
    const res = await xrpc<{ thread?: ThreadPost }>(
      APPVIEW,
      `app.bsky.feed.getPostThread?uri=${encodeURIComponent(postId)}&depth=1`,
      { method: 'GET' },
    );
    return (res.thread?.replies ?? []).map(
      (r): InboxComment => ({
        platform: 'bluesky',
        postId,
        commentId: `${r.post.uri}|${r.post.cid}`,
        author: r.post.author.handle,
        text: r.post.record.text ?? '',
        createdAt: r.post.record.createdAt ?? '',
      }),
    );
  },
  async reply(comment, text, env) {
    const s = await blueskySession(env);
    const root = await xrpc<{ posts?: Array<{ uri: string; cid: string }> }>(
      APPVIEW,
      `app.bsky.feed.getPosts?uris=${encodeURIComponent(comment.postId)}`,
      { method: 'GET' },
    );
    const [parentUri, parentCid] = comment.commentId.split('|');
    const rootRef = root.posts?.[0];
    if (!rootRef || !parentUri || !parentCid)
      throw new PlatformError('BLUESKY_REPLY', 'Cannot resolve the post being replied to.');
    const facets = detectFacets(text);
    const res = await xrpc<{ uri: string }>(s.service, 'com.atproto.repo.createRecord', {
      token: s.accessJwt,
      body: {
        repo: s.did,
        collection: 'app.bsky.feed.post',
        record: {
          $type: 'app.bsky.feed.post',
          text,
          createdAt: new Date().toISOString(),
          reply: { root: rootRef, parent: { uri: parentUri, cid: parentCid } },
          ...(facets.length ? { facets } : {}),
        },
      },
    });
    return { id: res.uri };
  },
});
