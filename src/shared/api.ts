import { PlatformError } from './errors';
import { fetchWithRetry } from './http';

// Small JSON client for REST APIs with bearer tokens. Non-GET requests are retried only on
// 429, because publishing calls are not idempotent.

export interface ApiOptions {
  base: string;
  token: () => Promise<string>;
  headers?: Record<string, string>;
  /** Maps an error response to a PlatformError with a useful hint. */
  onError?: (status: number, body: unknown) => PlatformError | undefined;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface ApiResponse<T> {
  status: number;
  headers: Headers;
  body: T;
}

export class ApiClient {
  constructor(private readonly opts: ApiOptions) {}

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<ApiResponse<T>> {
    const url = /^https?:\/\//.test(path) ? path : `${this.opts.base}${path}`;
    const headers: Record<string, string> = {
      authorization: `Bearer ${await this.opts.token()}`,
      accept: 'application/json',
      ...this.opts.headers,
      ...extraHeaders,
    };
    let payload: RequestInit['body'];
    if (body instanceof FormData || body instanceof Blob || typeof body === 'string')
      payload = body as RequestInit['body'];
    else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers['content-type'] = 'application/json';
    }
    const res = await fetchWithRetry(
      url,
      { method, headers, body: payload },
      { retryOn: method === 'GET' ? undefined : [429], fetchImpl: this.opts.fetchImpl, sleep: this.opts.sleep },
    );
    const text = await res.text();
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      // keep raw text
    }
    if (!res.ok) {
      throw (
        this.opts.onError?.(res.status, parsed) ??
        new PlatformError(
          `HTTP_${res.status}`,
          `Request to ${new URL(url).pathname} failed (HTTP ${res.status}): ${typeof parsed === 'string' ? parsed.slice(0, 300) : JSON.stringify(parsed).slice(0, 300)}`,
        )
      );
    }
    return { status: res.status, headers: res.headers, body: parsed as T };
  }

  get<T = unknown>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  post<T = unknown>(path: string, body?: unknown, headers?: Record<string, string>): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, body, headers);
  }
}
