import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { xCost } from '../src/platforms/approval-notes';
import { googleAccessToken } from '../src/platforms/google/oauth';
import { toYouTubeError } from '../src/platforms/youtube/errors';
import { youtubeRest } from '../src/platforms/youtube/rest';
import { writeSecretJson } from '../src/shared/token-store';
import { tmp, write } from './helpers';

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

describe('YouTube REST client', () => {
  it('sends the API key as a header, never in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ items: [] }));
    await youtubeRest({ apiKey: 'AIzaSECRET' }, fetchImpl).videos.list({ part: ['statistics'], id: ['v1'] });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://www.googleapis.com/youtube/v3/videos?part=statistics&id=v1');
    expect(url).not.toContain('AIzaSECRET');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('AIzaSECRET');
  });

  it('uploads with a resumable session: metadata first, then the file', async () => {
    const path = write(join(tmp(), 'v.mp4'), 'video-bytes');
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 200, headers: { location: 'https://upload.example/session1' } }),
      )
      .mockResolvedValueOnce(json({ id: 'vid9', status: { privacyStatus: 'private' } }));
    const api = youtubeRest({ bearer: async () => 'tok' }, fetchImpl);
    const res = await api.videos.insert({
      part: ['snippet', 'status'],
      notifySubscribers: false,
      requestBody: { snippet: { title: 'T' } },
      media: { path, mimeType: 'video/*' },
    });

    const [startUrl, start] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(startUrl).toBe(
      'https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet%2Cstatus&notifySubscribers=false',
    );
    expect(start.method).toBe('POST');
    expect(start.headers).toMatchObject({ authorization: 'Bearer tok', 'x-upload-content-length': '11' });
    expect(JSON.parse(start.body as string)).toEqual({ snippet: { title: 'T' } });

    const [putUrl, put] = fetchImpl.mock.calls[1] as [string, RequestInit];
    expect(putUrl).toBe('https://upload.example/session1');
    expect(put.method).toBe('PUT');
    expect(await (put.body as Blob).text()).toBe('video-bytes');
    expect(res.data.id).toBe('vid9');
  });

  it("keeps Google's error reason so quota errors get the right hint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(json({ error: { code: 403, message: 'quota', errors: [{ reason: 'quotaExceeded' }] } }, 403));
    const error = await youtubeRest({ apiKey: 'k' }, fetchImpl)
      .search.list({ part: ['snippet'], q: 'ble', type: ['video'], maxResults: 5, order: 'relevance' })
      .catch((e: unknown) => e);
    expect(toYouTubeError(error).code).toBe('YT_QUOTA_EXCEEDED');
  });
});

describe('Google access tokens', () => {
  const client = { clientId: 'cid', clientSecret: 'csec' };

  it('reuses a valid token and refreshes one that is about to expire', async () => {
    const tokenFile = join(tmp(), 'token.json');
    const now = Date.parse('2026-11-06T10:00:00Z');
    writeSecretJson(tokenFile, { access_token: 'old', refresh_token: 'r1', expiry_date: now + 3_600_000 });
    const fetchImpl = vi.fn().mockResolvedValue(json({ access_token: 'new', expires_in: 3599, token_type: 'Bearer' }));

    expect(await googleAccessToken({ client, tokenFile, notSignedInHint: '', fetchImpl, now: () => now })).toBe('old');
    expect(fetchImpl).not.toHaveBeenCalled();

    const later = now + 3_600_000 - 60_000;
    expect(await googleAccessToken({ client, tokenFile, notSignedInHint: '', fetchImpl, now: () => later })).toBe(
      'new',
    );
    const body = new URLSearchParams((fetchImpl.mock.calls[0] as [string, RequestInit])[1].body as string);
    expect(Object.fromEntries(body)).toEqual({
      client_id: 'cid',
      client_secret: 'csec',
      refresh_token: 'r1',
      grant_type: 'refresh_token',
    });
    expect(JSON.parse(readFileSync(tokenFile, 'utf8'))).toMatchObject({ access_token: 'new', refresh_token: 'r1' });
  });

  it('maps an expired refresh token to the re-authorise hint', async () => {
    const tokenFile = join(tmp(), 'token.json');
    writeSecretJson(tokenFile, { access_token: 'old', refresh_token: 'r1', expiry_date: 0 });
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, 400),
      );
    const error = await googleAccessToken({ client, tokenFile, notSignedInHint: '', fetchImpl }).catch(
      (e: unknown) => e,
    );
    expect(toYouTubeError(error).code).toBe('YT_TOKEN_EXPIRED');
  });
});

describe('approval notes', () => {
  it('prices the same post the same way every time (no /g regex state)', () => {
    const draft = { platform: 'x', kind: 'text', text: 'see https://a.com' };
    expect([xCost(draft), xCost(draft), xCost(draft)]).toEqual([0.2, 0.2, 0.2]);
  });
});
