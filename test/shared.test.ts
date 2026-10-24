import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { formatError, PlatformError } from '../src/shared/errors';
import { fetchWithRetry, parseRetryAfter } from '../src/shared/http';
import { redact } from '../src/shared/log';
import { QuotaLedger } from '../src/shared/quota';
import { isTooOpen, readSecretJson, writeSecretJson } from '../src/shared/token-store';
import { tmp } from './helpers';

describe('redact', () => {
  it('masks secret env values but not paths', () => {
    const env = { WA_ACCESS_TOKEN: 'EAAG-very-secret-value', YT_TOKEN_PATH: '/home/u/token.json' };
    expect(redact('token EAAG-very-secret-value at /home/u/token.json', env)).toBe(
      'token [REDACTED] at /home/u/token.json',
    );
  });

  it('masks bearer headers, Google tokens and JSON token fields', () => {
    const text = [
      'Authorization: Bearer abc.def-ghi',
      'ya29.a0AfH6SMBx',
      '{"refresh_token":"1//0gabcdefghijklmnopqrstuvwxyz","client_secret":"GOCSPX-xyz"}',
      `key=AIza${'A'.repeat(35)}`,
    ].join('\n');
    const out = redact(text, {});
    expect(out).not.toMatch(/abc\.def|ya29\.a0|1\/\/0g|GOCSPX|AIzaAAAA/);
    expect(out).toContain('"refresh_token":"[REDACTED]');
  });
});

describe('token store', () => {
  it('writes with mode 0600', () => {
    const path = join(tmp(), 'cfg', 'youtube', 'token.json');
    writeSecretJson(path, { refresh_token: 'x' });
    expect(readSecretJson(path)).toEqual({ refresh_token: 'x' });
    if (process.platform !== 'win32') {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(isTooOpen(path)).toBe(false);
    }
  });

  it('refuses to write inside a git repository', () => {
    const repo = tmp();
    mkdirSync(join(repo, '.git'));
    expect(() => writeSecretJson(join(repo, 'secrets', 'token.json'), {})).toThrow(/inside the git repository/);
  });
});

describe('fetchWithRetry', () => {
  const ok = () => new Response('ok', { status: 200 });

  it('retries 429 and 5xx then succeeds', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 429, headers: { 'retry-after': '1' } }))
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(ok());
    const sleep = vi.fn().mockResolvedValue(undefined);
    const res = await fetchWithRetry('https://example.test', {}, { fetchImpl, sleep });
    expect(res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls[0]?.[0]).toBe(1000);
  });

  it('does not retry client errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('', { status: 400 }));
    const res = await fetchWithRetry('https://example.test', {}, { fetchImpl, sleep: async () => {} });
    expect(res.status).toBe(400);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('gives up after the retry budget and rethrows network errors', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNRESET'));
    await expect(
      fetchWithRetry('https://example.test', {}, { retries: 2, fetchImpl, sleep: async () => {} }),
    ).rejects.toThrow('ECONNRESET');
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('parses Retry-After dates', () => {
    expect(parseRetryAfter('Wed, 21 Oct 2026 07:28:10 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT'))).toBe(10_000);
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe('QuotaLedger', () => {
  it('tracks usage per Pacific day and resets at midnight PT', () => {
    let now = new Date('2026-10-23T06:59:00Z'); // 23:59 PDT on Oct 22
    const ledger = new QuotaLedger({
      path: join(tmp(), 'q.json'),
      dailyLimit: 100,
      resetTimeZone: 'America/Los_Angeles',
      now: () => now,
    });
    ledger.record(60);
    expect(ledger.today()).toBe('2026-10-22');
    expect(ledger.canSpend(50)).toBe(false);
    now = new Date('2026-10-23T07:01:00Z'); // 00:01 PDT on Oct 23
    expect(ledger.remaining()).toBe(100);
  });
});

describe('formatError', () => {
  it('includes code, hint and docs', () => {
    expect(formatError(new PlatformError('X', 'Broken.', 'Fix it.', 'https://docs'))).toBe(
      'Error [X]: Broken.\nHint: Fix it.\nDocs: https://docs',
    );
  });
});
