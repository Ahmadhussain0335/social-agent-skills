export interface RetryOptions {
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: readonly number[];
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_RETRY_ON = [429, 500, 502, 503, 504] as const;

const defaultSleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * fetch with exponential backoff and jitter for rate limits and transient server errors.
 * Honours Retry-After. Request bodies must be replayable (string, Buffer), not streams.
 */
export async function fetchWithRetry(
  url: string | URL,
  init: RequestInit = {},
  opts: RetryOptions = {},
): Promise<Response> {
  const retries = opts.retries ?? 3;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 30_000;
  const retryOn = opts.retryOn ?? DEFAULT_RETRY_ON;
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; ; attempt++) {
    let response: Response | undefined;
    try {
      response = await doFetch(url, init);
    } catch (error) {
      if (attempt >= retries) throw error;
    }
    if (response && (!retryOn.includes(response.status) || attempt >= retries)) {
      return response;
    }
    const retryAfter = response ? parseRetryAfter(response.headers.get('retry-after')) : undefined;
    const backoff = Math.min(max, base * 2 ** attempt) * (0.5 + Math.random() / 2);
    await sleep(Math.min(max, retryAfter ?? backoff));
  }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}
