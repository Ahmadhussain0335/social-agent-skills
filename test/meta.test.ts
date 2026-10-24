import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  type FacebookTokens,
  finishFacebookLogin,
  selectInstagram,
  selectPage,
  startFacebookLogin,
} from '../src/platforms/meta/accounts';
import { waitForContainer } from '../src/platforms/meta/containers';
import { checkFacebookPost, publishFacebook } from '../src/platforms/meta/facebook';
import { checkInstagramPost, publishInstagram } from '../src/platforms/meta/instagram';
import { finishPasteback, startPasteback } from '../src/platforms/meta/pasteback';
import {
  finishThreadsLogin,
  needsRefresh,
  refreshThreadsToken,
  startThreadsLogin,
} from '../src/platforms/threads/auth';
import { checkThreadsPost, publishThreads, threadsLength, uniqueLinks } from '../src/platforms/threads/publish';
import type { PostDraft } from '../src/shared/post-project';
import { tmp, write } from './helpers';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const env = () => ({
  SOCIAL_SKILLS_CONFIG_DIR: tmp(),
  META_APP_ID: 'app1',
  META_APP_SECRET: 'sec1',
  META_REDIRECT_URI: 'https://me.example.com/cb',
  THREADS_APP_ID: 'tapp',
  THREADS_APP_SECRET: 'tsec',
  THREADS_REDIRECT_URI: 'https://me.example.com/threads',
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('paste-back OAuth', () => {
  it('round-trips state and strips the trailing #_', () => {
    const e = env();
    const url = new URL(
      startPasteback(
        'threads',
        'https://threads.com/oauth/authorize',
        { client_id: 'x' },
        'https://me.example.com/cb',
        e,
      ),
    );
    const state = url.searchParams.get('state');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(finishPasteback('threads', `https://me.example.com/cb?code=abc&state=${state}#_`, e)).toEqual({
      code: 'abc',
      redirectUri: 'https://me.example.com/cb',
    });
    expect(() => finishPasteback('threads', `https://me.example.com/cb?code=abc&state=${state}`, e)).toThrow(
      /No sign-in in progress/,
    );
  });

  it('rejects a mismatched state and denied sign-ins', () => {
    const e = env();
    startPasteback('facebook', 'https://www.facebook.com/v26.0/dialog/oauth', {}, 'https://me.example.com/cb', e);
    expect(() => finishPasteback('facebook', 'https://me.example.com/cb?code=a&state=wrong', e)).toThrow(
      /state mismatch/,
    );
    expect(() => finishPasteback('facebook', 'https://me.example.com/cb?error=access_denied', e)).toThrow(
      /not completed/,
    );
  });
});

describe('Facebook login', () => {
  it('uses config_id when set instead of a scope list', () => {
    const scoped = new URL(startFacebookLogin(env()));
    expect(scoped.searchParams.get('scope')).toContain('pages_manage_posts');
    expect(scoped.searchParams.get('scope')).not.toContain('business_management');
    const configured = new URL(startFacebookLogin({ ...env(), META_LOGIN_CONFIG_ID: 'cfg9' }));
    expect(configured.searchParams.get('config_id')).toBe('cfg9');
    expect(configured.searchParams.has('scope')).toBe(false);
  });

  it('exchanges the code, upgrades the token and stores Page tokens', async () => {
    const e = env();
    const state = new URL(startFacebookLogin(e)).searchParams.get('state');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'short' }))
      .mockResolvedValueOnce(json({ access_token: 'long', expires_in: 5_184_000 }));
    const graph = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      json({
        data: [
          {
            id: 'p1',
            name: 'Shop',
            access_token: 'pt',
            tasks: ['CREATE_CONTENT'],
            instagram_business_account: { id: 'ig1', username: 'shop' },
          },
        ],
      }),
    );
    const tokens = await finishFacebookLogin(`https://me.example.com/cb?code=c&state=${state}`, e, fetchImpl);
    graph.mockRestore();
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('grant_type=fb_exchange_token');
    expect(tokens.pages).toEqual([
      {
        id: 'p1',
        name: 'Shop',
        accessToken: 'pt',
        tasks: ['CREATE_CONTENT'],
        instagram: { id: 'ig1', username: 'shop' },
      },
    ]);
  });

  it('selects Pages and Instagram accounts unambiguously', () => {
    const tokens: FacebookTokens = {
      obtainedAt: '',
      pages: [
        { id: 'p1', name: 'A', accessToken: 'a', tasks: [], instagram: { id: 'ig1' } },
        { id: 'p2', name: 'B', accessToken: 'b', tasks: [] },
      ],
    };
    expect(() => selectPage(tokens)).toThrow(/Several Pages/);
    expect(selectPage(tokens, 'p2').name).toBe('B');
    expect(selectInstagram(tokens).igUserId).toBe('ig1');
  });
});

describe('Facebook Page posts', () => {
  const base: PostDraft = { platform: 'facebook', kind: 'text', text: 'Hello' };

  it('validates kinds, media and the scheduling window', () => {
    expect(checkFacebookPost(base, NOW).ok).toBe(true);
    expect(checkFacebookPost({ ...base, scheduledAt: '2026-10-24T12:05:00Z' }, NOW).errors).toEqual([
      'scheduledAt must be at least 10 minutes in the future',
    ]);
    expect(checkFacebookPost({ ...base, scheduledAt: '2026-12-24T12:00:00Z' }, NOW).errors).toEqual([
      'scheduledAt must be within 30 days',
    ]);
    expect(
      checkFacebookPost({ ...base, kind: 'photos', media: [{ source: 'a.jpg', type: 'image' }] }, NOW).errors,
    ).toEqual(['photos posts need two or more images']);
  });

  it('schedules a text post and uploads local photos as multipart', async () => {
    const dir = tmp();
    write(join(dir, 'a.jpg'), 'jpeg');
    const client = {
      post: vi.fn().mockResolvedValue({ id: 'post1' }),
      postFile: vi.fn().mockResolvedValue({ id: 'ph1', post_id: 'pg_ph1' }),
    };
    await publishFacebook(client as never, 'P', dir, { ...base, scheduledAt: '2026-10-25T12:00:00Z' });
    expect(client.post).toHaveBeenCalledWith(
      'P/feed',
      expect.objectContaining({ published: false, scheduled_publish_time: 1792929600 }),
    );

    const res = await publishFacebook(client as never, 'P', dir, {
      ...base,
      kind: 'photo',
      media: [{ source: 'a.jpg', type: 'image', altText: 'alt' }],
    });
    expect(client.postFile).toHaveBeenCalledWith(
      'P/photos',
      expect.objectContaining({ caption: 'Hello', alt_text_custom: 'alt' }),
      expect.objectContaining({ field: 'source', contentType: 'image/jpeg' }),
    );
    expect(res.id).toBe('pg_ph1');
  });

  it('attaches unpublished photos to one feed post', async () => {
    const client = {
      post: vi
        .fn()
        .mockResolvedValueOnce({ id: 'a' })
        .mockResolvedValueOnce({ id: 'b' })
        .mockResolvedValueOnce({ id: 'feed1' }),
    };
    await publishFacebook(client as never, 'P', tmp(), {
      ...base,
      kind: 'photos',
      media: [
        { source: 'https://x/a.jpg', type: 'image' },
        { source: 'https://x/b.jpg', type: 'image' },
      ],
    });
    expect(client.post.mock.calls[2]?.[1]).toMatchObject({
      'attached_media[0]': '{"media_fbid":"a"}',
      'attached_media[1]': '{"media_fbid":"b"}',
    });
  });
});

describe('Instagram posts', () => {
  it('requires public JPEG images and enforces caption limits', () => {
    const r = checkInstagramPost({
      platform: 'instagram',
      kind: 'image',
      text: `${'#tag '.repeat(31)}`,
      media: [{ source: 'local.jpg', type: 'image' }],
      scheduledAt: '2026-11-01T00:00:00Z',
    });
    expect(r.errors).toEqual([
      'Instagram API publishing has no scheduling; remove scheduledAt and publish at the chosen time',
      'more than 30 hashtags',
      'media[0] (local.jpg): Instagram fetches images from a public https URL; host the JPEG and use its URL',
    ]);
  });

  it('creates a container, waits for FINISHED and publishes', async () => {
    const client = {
      post: vi.fn().mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 'm1' }),
      get: vi
        .fn()
        .mockResolvedValueOnce({ status_code: 'IN_PROGRESS' })
        .mockResolvedValueOnce({ status_code: 'FINISHED' })
        .mockResolvedValueOnce({ permalink: 'https://instagram.com/p/x' }),
    };
    const res = await publishInstagram(
      {
        client: client as never,
        igUserId: 'ig1',
        accessToken: 't',
        graphVersion: 'v26.0',
        dir: tmp(),
        sleep: async () => {},
      },
      {
        platform: 'instagram',
        kind: 'image',
        text: 'Hi',
        media: [{ source: 'https://x/a.jpg', type: 'image', altText: 'a' }],
      },
    );
    expect(client.post.mock.calls[0]).toEqual([
      'ig1/media',
      expect.objectContaining({ image_url: 'https://x/a.jpg', caption: 'Hi', alt_text: 'a' }),
    ]);
    expect(client.post.mock.calls[1]).toEqual(['ig1/media_publish', { creation_id: 'c1' }]);
    expect(res).toEqual({ id: 'm1', permalink: 'https://instagram.com/p/x' });
  });

  it('uploads a local reel with the resumable upload', async () => {
    const dir = tmp();
    write(join(dir, 'r.mp4'), 'video-bytes');
    const fetchImpl = vi.fn().mockResolvedValue(json({ success: true }));
    const client = {
      post: vi.fn().mockResolvedValueOnce({ id: 'c9' }).mockResolvedValueOnce({ id: 'm9' }),
      get: vi.fn().mockResolvedValueOnce({ status_code: 'FINISHED' }).mockResolvedValueOnce({}),
    };
    await publishInstagram(
      {
        client: client as never,
        igUserId: 'ig1',
        accessToken: 'tok',
        graphVersion: 'v26.0',
        dir,
        sleep: async () => {},
        fetchImpl,
      },
      { platform: 'instagram', kind: 'reel', text: 'R', media: [{ source: 'r.mp4', type: 'video' }] },
    );
    expect(client.post.mock.calls[0]?.[1]).toMatchObject({ media_type: 'REELS', upload_type: 'resumable' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://rupload.facebook.com/ig-api-upload/v26.0/c9');
    expect(init.headers).toMatchObject({ Authorization: 'OAuth tok', offset: '0', file_size: '11' });
  });
});

describe('Threads', () => {
  it('counts emoji by UTF-8 bytes and links by unique URL', () => {
    expect(threadsLength('hi')).toBe(2);
    expect(threadsLength('hi 👍')).toBe(3 + 4);
    expect(uniqueLinks('see https://a.com and https://a.com, https://b.com', 'https://c.com')).toBe(3);
  });

  it('validates posts', () => {
    expect(
      checkThreadsPost({ platform: 'threads', kind: 'text', text: 'Hello', options: { topicTag: 'BLE' } }).ok,
    ).toBe(true);
    expect(
      checkThreadsPost({
        platform: 'threads',
        kind: 'image',
        text: 'x'.repeat(501),
        media: [{ source: 'a.jpg', type: 'image' }],
        options: { topicTag: 'a.b' },
      }).errors,
    ).toEqual([
      'text exceeds 500 characters',
      'media[0]: Threads fetches media from a public https URL; local files are not supported',
      'options.topicTag must be 1-50 characters without "." or "&"',
    ]);
  });

  it('publishes a text post with a link attachment', async () => {
    const client = {
      post: vi.fn().mockResolvedValueOnce({ id: 'c1' }).mockResolvedValueOnce({ id: 't1' }),
      get: vi
        .fn()
        .mockResolvedValueOnce({ status: 'FINISHED' })
        .mockResolvedValueOnce({ permalink: 'https://threads.com/p/1' }),
    };
    const res = await publishThreads(
      client as never,
      'u1',
      { platform: 'threads', kind: 'text', text: 'Hi', link: 'https://a.com' },
      async () => {},
    );
    expect(client.post.mock.calls[0]).toEqual([
      'u1/threads',
      expect.objectContaining({ media_type: 'TEXT', link_attachment: 'https://a.com' }),
    ]);
    expect(res.permalink).toBe('https://threads.com/p/1');
  });

  it('exchanges for a 60-day token and refreshes only after 24 hours', async () => {
    const e = env();
    const state = new URL(startThreadsLogin(e)).searchParams.get('state');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(json({ access_token: 'short', user_id: 'u1' }))
      .mockResolvedValueOnce(json({ access_token: 'long', expires_in: 5_184_000 }));
    const tokens = await finishThreadsLogin(`https://me.example.com/threads?code=c&state=${state}#_`, e, fetchImpl);
    expect(tokens).toMatchObject({ accessToken: 'long', userId: 'u1' });
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain('grant_type=th_exchange_token');

    const refresh = vi.fn().mockResolvedValue(json({ access_token: 'newer', expires_in: 5_184_000 }));
    expect((await refreshThreadsToken(e, refresh)).accessToken).toBe('long');
    expect(refresh).not.toHaveBeenCalled();
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    expect((await refreshThreadsToken(e, refresh, later)).accessToken).toBe('newer');
    expect(
      needsRefresh(
        { accessToken: 'x', userId: 'u', obtainedAt: '2026-08-01T00:00:00Z', expiresAt: '2026-10-28T00:00:00Z' },
        NOW,
      ),
    ).toBe(true);
  });
});

describe('waitForContainer', () => {
  it('fails clearly on processing errors and times out', async () => {
    const err = { get: vi.fn().mockResolvedValue({ status_code: 'ERROR', error_message: 'bad media' }) };
    await expect(waitForContainer(err as never, 'c', { field: 'status_code', sleep: async () => {} })).rejects.toThrow(
      /failed: bad media/,
    );
    const slow = { get: vi.fn().mockResolvedValue({ status: 'IN_PROGRESS' }) };
    await expect(
      waitForContainer(slow as never, 'c', { field: 'status', sleep: async () => {}, attempts: 2 }),
    ).rejects.toMatchObject({
      code: 'META_MEDIA_TIMEOUT',
    });
  });
});
