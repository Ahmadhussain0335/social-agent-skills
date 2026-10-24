import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import '../src/platforms/all-posting';
import { checkBlueskyPost, detectFacets, graphemes } from '../src/platforms/bluesky';
import { checkDiscordPost, publishDiscord } from '../src/platforms/discord';
import { checkGbpPost } from '../src/platforms/gbp';
import { checkLinkedInPost, escapeLittleText } from '../src/platforms/linkedin';
import { checkMastodonPost, mastodonLength } from '../src/platforms/mastodon';
import { checkPinterestPost } from '../src/platforms/pinterest';
import { postPlatform, postPlatforms } from '../src/platforms/posting';
import { checkRedditDraft } from '../src/platforms/reddit';
import { checkTelegramPost, publishTelegram } from '../src/platforms/telegram';
import { checkTikTokPost } from '../src/platforms/tiktok';
import { checkXPost, publishX, xCost, xLength } from '../src/platforms/x';
import { ApiClient } from '../src/shared/api';
import {
  accessToken,
  createPkce,
  finishPasteback,
  loopbackAuthorize,
  saveToken,
  startPasteback,
} from '../src/shared/oauth';
import type { PostDraft } from '../src/shared/post-project';
import { tmp, write } from './helpers';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('registry', () => {
  it('registers all single-post platforms', () => {
    expect(
      postPlatforms()
        .map((p) => p.id)
        .sort(),
    ).toEqual(
      [
        'bluesky',
        'discord',
        'facebook',
        'google-business',
        'instagram',
        'linkedin',
        'mastodon',
        'pinterest',
        'reddit',
        'telegram',
        'threads',
        'tiktok',
        'x',
      ].sort(),
    );
  });
});

describe('shared OAuth', () => {
  it('creates S256 PKCE in base64url and hex (TikTok desktop)', () => {
    const b = createPkce();
    expect(b.challenge).toBe(createHash('sha256').update(b.verifier).digest('base64url'));
    const h = createPkce('hex');
    expect(h.challenge).toMatch(/^[0-9a-f]{64}$/);
  });

  it('paste-back keeps the PKCE verifier and validates state', () => {
    const env = { SOCIAL_SKILLS_CONFIG_DIR: tmp() };
    const pkce = createPkce();
    const url = new URL(
      startPasteback({
        platform: 'demo',
        authorizeUrl: 'https://auth.example/o',
        params: { client_id: 'c' },
        redirectUri: 'https://me.example/cb',
        pkce,
        env,
      }),
    );
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const done = finishPasteback('demo', `https://me.example/cb?code=k&state=${url.searchParams.get('state')}`, env);
    expect(done).toEqual({ code: 'k', redirectUri: 'https://me.example/cb', verifier: pkce.verifier });
  });

  it('refreshes tokens that are about to expire and saves the result', async () => {
    const env = { SOCIAL_SKILLS_CONFIG_DIR: tmp() };
    saveToken(
      'demo',
      {
        accessToken: 'old',
        refreshToken: 'r1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        obtainedAt: '',
      },
      env,
    );
    const refresh = vi.fn().mockResolvedValue({
      accessToken: 'new',
      refreshToken: 'r2',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      obtainedAt: '',
    });
    expect(await accessToken('demo', refresh, env)).toBe('new');
    expect(await accessToken('demo', refresh, env)).toBe('new');
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('receives the code on a loopback redirect', async () => {
    let authUrl = '';
    const pending = loopbackAuthorize({
      platform: 'demo',
      authorizeUrl: 'https://auth.example/o',
      params: {},
      redirectUri: 'http://127.0.0.1:18765/callback',
      onUrl: (u) => {
        authUrl = u;
      },
    });
    await new Promise((r) => setTimeout(r, 50));
    const state = new URL(authUrl).searchParams.get('state');
    const res = await fetch(`http://127.0.0.1:18765/callback?code=abc&state=${state}`);
    expect(res.status).toBe(200);
    expect(await pending).toEqual({ code: 'abc', redirectUri: 'http://127.0.0.1:18765/callback' });
  });
});

describe('X', () => {
  it('counts URLs as 23 and wide characters as 2', () => {
    expect(xLength('hi https://example.com/a/very/long/path')).toBe(3 + 23);
    expect(xLength('日本')).toBe(4);
  });

  it('prices link posts higher and validates media', () => {
    const base: PostDraft = { platform: 'x', kind: 'text', text: 'Hello' };
    expect(xCost(base)).toBe(0.015);
    expect(xCost({ ...base, text: 'see https://a.com' })).toBe(0.2);
    expect(checkXPost({ ...base, text: 'see https://a.com' }).warnings[0]).toMatch(/\$0\.2/);
    const media = Array.from({ length: 5 }, (_, i) => ({ source: `${i}.jpg`, type: 'image' as const }));
    expect(checkXPost({ ...base, kind: 'media', media }).errors).toContain('at most 4 images');
  });

  it('creates the post with the v2 payload', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ data: { id: '99' } }, 201));
    const client = new ApiClient({ base: 'https://api.x.com', token: async () => 't', fetchImpl });
    const res = await publishX(client, tmp(), {
      platform: 'x',
      kind: 'poll',
      text: 'Pick',
      options: { poll: { options: ['A', 'B'] }, madeWithAi: true },
    });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.x.com/2/tweets');
    expect(JSON.parse(init.body as string)).toEqual({
      text: 'Pick',
      poll: { options: ['A', 'B'], duration_minutes: 1440 },
      made_with_ai: true,
    });
    expect(res).toMatchObject({ id: '99', estimatedCost: '$0.015' });
  });
});

describe('LinkedIn', () => {
  it('escapes little-text characters but keeps hashtags', () => {
    expect(escapeLittleText('Hi (team) @all [1] #ble')).toBe('Hi \\(team\\) \\@all \\[1\\] #ble');
  });
  it('validates kinds and length', () => {
    expect(checkLinkedInPost({ platform: 'linkedin', kind: 'text', text: 'x'.repeat(3001) }).errors).toEqual([
      'text exceeds 3,000 characters',
    ]);
    expect(
      checkLinkedInPost({
        platform: 'linkedin',
        kind: 'image',
        text: 'a',
        media: [{ source: 'https://x/y.jpg', type: 'image' }],
      }).errors[0],
    ).toMatch(/local files/);
  });
});

describe('Pinterest', () => {
  it('requires a board and enforces field limits', () => {
    const r = checkPinterestPost({
      platform: 'pinterest',
      kind: 'image',
      text: 'x'.repeat(801),
      media: [{ source: 'a.jpg', type: 'image' }],
      options: { title: 't'.repeat(101) },
    });
    expect(r.errors).toEqual([
      'options.boardId is required (list boards with the auth script --boards)',
      'options.title exceeds 100 characters',
      'text (description) exceeds 800 characters',
    ]);
  });
});

describe('TikTok', () => {
  const video = [{ source: 'v.mp4', type: 'video' as const }];
  it('allows draft mode with only a video', () => {
    expect(checkTikTokPost({ platform: 'tiktok', kind: 'video', media: video }).ok).toBe(true);
  });
  it('requires explicit user choices in direct mode, with no defaults', () => {
    const r = checkTikTokPost({ platform: 'tiktok', kind: 'video', media: video, options: { mode: 'direct' } });
    expect(r.errors).toEqual([
      'direct mode needs options.privacyLevel chosen by the user from --creator-info (no default)',
      'direct mode needs options.creatorNickname from --creator-info, shown to the user at approval',
      'direct mode needs options.allowComment set explicitly by the user (true or false)',
      'direct mode needs options.allowDuet set explicitly by the user (true or false)',
      'direct mode needs options.allowStitch set explicitly by the user (true or false)',
    ]);
    const branded = checkTikTokPost({
      platform: 'tiktok',
      kind: 'video',
      media: video,
      options: {
        mode: 'direct',
        privacyLevel: 'SELF_ONLY',
        creatorNickname: 'me',
        allowComment: false,
        allowDuet: false,
        allowStitch: false,
        brandedContent: true,
      },
    });
    expect(branded.errors).toEqual(['branded content cannot be private (TikTok rule)']);
  });
  it('shows the TikTok declaration at approval', () => {
    const notes = postPlatform('tiktok').approvalNotes?.({
      platform: 'tiktok',
      kind: 'video',
      options: { mode: 'direct', creatorNickname: 'me', privacyLevel: 'SELF_ONLY' },
    });
    expect(notes?.join(' ')).toMatch(/Music Usage Confirmation/);
  });
});

describe('Telegram', () => {
  it('enforces caption and album limits', () => {
    expect(
      checkTelegramPost({
        platform: 'telegram',
        kind: 'photo',
        text: 'x'.repeat(1025),
        media: [{ source: 'a.jpg', type: 'image' }],
      }).errors,
    ).toEqual(['caption exceeds 1024 characters']);
  });
  it('sends plain text by default and builds the post URL', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ ok: true, result: { message_id: 7, chat: { username: 'chan' } } }));
    const res = await publishTelegram(
      tmp(),
      { platform: 'telegram', kind: 'text', text: 'Hi' },
      { TELEGRAM_BOT_TOKEN: 'T', TELEGRAM_CHAT_ID: '@chan' },
      fetchImpl,
    );
    const body = JSON.parse((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(body).not.toHaveProperty('parse_mode');
    expect(res).toEqual({ id: '7', url: 'https://t.me/chan/7' });
  });
});

describe('Discord', () => {
  it('never pings by default', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: 'm1', channel_id: 'c1' }));
    await publishDiscord(
      tmp(),
      { platform: 'discord', kind: 'text', text: '@everyone hi' },
      { DISCORD_WEBHOOK_URL: 'https://discord.com/api/webhooks/1/abc' },
      fetchImpl,
    );
    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(String(url)).toContain('wait=true');
    expect(JSON.parse((init.body as FormData).get('payload_json') as string).allowed_mentions).toEqual({ parse: [] });
    expect(checkDiscordPost({ platform: 'discord', kind: 'text', text: '@everyone hi' }).warnings[0]).toMatch(
      /will not ping/,
    );
  });
});

describe('Bluesky', () => {
  it('counts graphemes and builds byte-offset facets', () => {
    expect(graphemes('👍🏽 ok')).toBe(4);
    const text = 'Hi 👍 see https://a.com #BLE';
    const facets = detectFacets(text);
    const link = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#link');
    const tag = facets.find((f) => f.features[0]?.$type === 'app.bsky.richtext.facet#tag');
    const bytes = Buffer.from(text);
    expect(bytes.subarray(link?.index.byteStart, link?.index.byteEnd).toString()).toBe('https://a.com');
    expect(bytes.subarray(tag?.index.byteStart, tag?.index.byteEnd).toString()).toBe('#BLE');
  });
  it('requires alt text', () => {
    expect(
      checkBlueskyPost({ platform: 'bluesky', kind: 'images', text: 'x', media: [{ source: 'a.jpg', type: 'image' }] })
        .errors,
    ).toEqual(['a.jpg: alt text is required on Bluesky']);
  });
});

describe('Mastodon', () => {
  it('counts links as 23 and enforces the 5-minute schedule minimum', () => {
    expect(mastodonLength('hi https://example.com/long/path')).toBe(26);
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(
      checkMastodonPost({ platform: 'mastodon', kind: 'text', text: 'x', scheduledAt: '2026-10-24T12:03:00Z' }, now)
        .errors,
    ).toEqual(['scheduledAt must be at least 5 minutes ahead']);
  });
});

describe('Google Business Profile', () => {
  it('validates location, call to action and media', () => {
    const r = checkGbpPost({
      platform: 'google-business',
      kind: 'standard',
      text: 'Hi',
      media: [{ source: 'a.jpg', type: 'image' }],
      options: { location: 'x', cta: { actionType: 'BUY' } },
    });
    expect(r.errors).toEqual([
      'options.location must be "accounts/<id>/locations/<id>" (list them with the auth script --locations)',
      'options.cta.actionType must be one of BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP, CALL',
      'options.cta.url is required for this call to action',
      'media must be photos at public https URLs',
    ]);
  });
});

describe('Reddit', () => {
  it('validates drafts and never publishes', async () => {
    expect(
      checkRedditDraft({ platform: 'reddit', kind: 'self', text: 'Hi', options: { subreddit: 'r/x', title: '' } })
        .errors,
    ).toEqual(['options.subreddit must be a subreddit name without r/', 'options.title is required']);
    await expect(postPlatform('reddit').publish(tmp(), { platform: 'reddit', kind: 'self' }, {})).rejects.toMatchObject(
      { code: 'REDDIT_DRAFT_ONLY' },
    );
  });
});

it('helpers write files', () => {
  expect(write(join(tmp(), 'a.txt'), 'x')).toMatch(/a\.txt$/);
});
