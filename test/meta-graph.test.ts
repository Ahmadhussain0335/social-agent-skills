import { describe, expect, it, vi } from 'vitest';
import { appSecretProof, GraphClient, GraphError, parseUsage } from '../src/platforms/meta/graph';

function client(fetchImpl: typeof fetch, appSecret?: string) {
  return new GraphClient({
    baseUrl: 'https://graph.example.test',
    version: 'v99.0',
    accessToken: 'TOKEN123',
    appSecret,
    retry: { fetchImpl, sleep: async () => {} },
  });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    ...init,
    headers: { 'content-type': 'application/json', ...init.headers },
  });

describe('GraphClient', () => {
  it('sends GET params and the token in the query with appsecret_proof', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: '1' }));
    await client(fetchImpl, 'SECRET').get('/me', { fields: 'id,name' });
    const url = new URL(fetchImpl.mock.calls[0]?.[0] as string);
    expect(url.pathname).toBe('/v99.0/me');
    expect(url.searchParams.get('fields')).toBe('id,name');
    expect(url.searchParams.get('access_token')).toBe('TOKEN123');
    expect(url.searchParams.get('appsecret_proof')).toBe(appSecretProof('TOKEN123', 'SECRET'));
  });

  it('keeps the token out of the URL on POST', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ id: 'c1' }));
    await client(fetchImpl).post('17841/media', { caption: 'hello', image_url: 'https://x/y.jpg' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain('TOKEN123');
    const body = new URLSearchParams(init.body as string);
    expect(body.get('access_token')).toBe('TOKEN123');
    expect(body.get('caption')).toBe('hello');
  });

  it('does not retry POST on server errors, so publishing is never duplicated', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json({ error: { message: 'boom', code: 1 } }, { status: 500 }));
    await expect(client(fetchImpl).post('x/media_publish')).rejects.toBeInstanceOf(GraphError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('maps Graph errors to codes and hints', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({ error: { message: 'Session expired', code: 190, error_subcode: 463 } }, { status: 401 }),
      );
    await expect(client(fetchImpl).get('me')).rejects.toMatchObject({
      code: 'META_190_463',
      hint: expect.stringMatching(/auth script/),
    });
  });

  it('records rate usage from headers', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        json({}, { headers: { 'x-app-usage': '{"call_count":42,"total_time":10,"total_cputime":5}' } }),
      );
    const c = client(fetchImpl);
    await c.get('me');
    expect(c.lastUsage).toEqual({ maxPercent: 42, regainSeconds: undefined });
  });
});

describe('parseUsage', () => {
  it('reads business use case usage and regain time', () => {
    const headers = new Headers({
      'x-business-use-case-usage': JSON.stringify({
        '123': [
          { type: 'pages', call_count: 95, total_cputime: 10, total_time: 20, estimated_time_to_regain_access: 5 },
        ],
      }),
    });
    expect(parseUsage(headers)).toEqual({ maxPercent: 95, regainSeconds: 300 });
  });

  it('returns undefined without usage headers', () => {
    expect(parseUsage(new Headers())).toBeUndefined();
  });
});
