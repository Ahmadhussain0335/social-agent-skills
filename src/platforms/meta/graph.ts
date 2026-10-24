import { createHmac } from 'node:crypto';
import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { fetchWithRetry, type RetryOptions } from '../../shared/http';

// Shared client for every Meta Graph host (graph.facebook.com, graph.instagram.com,
// graph.threads.net). Platform modules add endpoints and error hints on top.

export interface GraphErrorBody {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
}

export class GraphError extends PlatformError {
  constructor(
    readonly status: number,
    readonly graph: GraphErrorBody,
    hint?: string,
  ) {
    super(
      `META_${graph.code ?? status}${graph.error_subcode ? `_${graph.error_subcode}` : ''}`,
      graph.error_user_msg || graph.message || `Graph API request failed with HTTP ${status}`,
      hint,
    );
    this.name = 'GraphError';
  }
}

export interface RateUsage {
  /** Highest percentage across app, page and business-use-case usage headers. */
  maxPercent: number;
  /** Seconds until access is regained, when Meta reports it. */
  regainSeconds?: number;
}

export interface GraphClientOptions {
  baseUrl: string;
  version: string;
  accessToken: string;
  /** When set, every call carries appsecret_proof, which Meta recommends for server-side calls. */
  appSecret?: string;
  retry?: RetryOptions;
  /** Maps a Graph error to an actionable hint for the user. */
  hintFor?: (error: GraphErrorBody, status: number) => string | undefined;
}

export type Params = Record<string, string | number | boolean | undefined>;

export class GraphClient {
  lastUsage: RateUsage | undefined;

  constructor(private readonly opts: GraphClientOptions) {}

  get(path: string, params: Params = {}): Promise<unknown> {
    return this.request('GET', path, params);
  }

  post(path: string, params: Params = {}): Promise<unknown> {
    return this.request('POST', path, params);
  }

  delete(path: string, params: Params = {}): Promise<unknown> {
    return this.request('DELETE', path, params);
  }

  /** multipart/form-data upload of one local file (Facebook Page photos and videos). */
  async postFile(
    path: string,
    params: Params,
    file: { field: string; path: string; contentType: string },
  ): Promise<unknown> {
    const form = new FormData();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) form.set(key, String(value));
    }
    form.set('access_token', this.opts.accessToken);
    if (this.opts.appSecret) form.set('appsecret_proof', appSecretProof(this.opts.accessToken, this.opts.appSecret));
    const blob = await openAsBlob(file.path, { type: file.contentType });
    form.set(file.field, blob, basename(file.path));
    // Uploads are not idempotent: no retry except on explicit rate limiting.
    const response = await fetchWithRetry(
      this.url(path),
      { method: 'POST', body: form },
      { retryOn: [429], ...this.opts.retry },
    );
    return this.parse(response);
  }

  url(path: string): string {
    const clean = path.startsWith('/') ? path.slice(1) : path;
    return `${this.opts.baseUrl}/${this.opts.version}/${clean}`;
  }

  async request(method: 'GET' | 'POST' | 'DELETE', path: string, params: Params = {}): Promise<unknown> {
    const query = new URLSearchParams();
    const body = new URLSearchParams();
    const target = method === 'POST' ? body : query;
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) target.set(key, String(value));
    }
    // Token and proof go in the body for POST so they never appear in URLs or proxy logs.
    const auth = method === 'POST' ? body : query;
    auth.set('access_token', this.opts.accessToken);
    if (this.opts.appSecret) auth.set('appsecret_proof', appSecretProof(this.opts.accessToken, this.opts.appSecret));

    const url = `${this.url(path)}${query.size > 0 ? `?${query}` : ''}`;
    const init: RequestInit = { method };
    if (method === 'POST') {
      init.body = body.toString();
      init.headers = { 'content-type': 'application/x-www-form-urlencoded' };
    }

    // Publishing calls are not idempotent, so only retry them on rate limits, never on 5xx.
    const retryOn = method === 'GET' ? undefined : [429];
    const response = await fetchWithRetry(url, init, { retryOn, ...this.opts.retry });
    return this.parse(response);
  }

  private async parse(response: Response): Promise<unknown> {
    this.lastUsage = parseUsage(response.headers);

    const text = await response.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new PlatformError('META_BAD_RESPONSE', `Graph API returned non-JSON (HTTP ${response.status}).`);
    }
    const error = (json as { error?: GraphErrorBody }).error;
    if (!response.ok || error) {
      const graph = error ?? { message: `HTTP ${response.status}` };
      throw new GraphError(response.status, graph, this.opts.hintFor?.(graph, response.status) ?? defaultHint(graph));
    }
    return json;
  }
}

export function appSecretProof(accessToken: string, appSecret: string): string {
  return createHmac('sha256', appSecret).update(accessToken).digest('hex');
}

/** Reads X-App-Usage, X-Page-Usage, X-Business-Use-Case-Usage and X-Ad-Account-Usage. */
export function parseUsage(headers: Headers): RateUsage | undefined {
  const values: number[] = [];
  let regain: number | undefined;
  const collect = (obj: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(obj)) {
      if (typeof value === 'number' && /^(call_count|total_cputime|total_time|acc_id_util_pct)$/.test(key)) {
        values.push(value);
      }
      if (key === 'estimated_time_to_regain_access' && typeof value === 'number' && value > 0) {
        regain = Math.max(regain ?? 0, value * 60);
      }
    }
  };
  for (const name of ['x-app-usage', 'x-page-usage', 'x-ad-account-usage']) {
    const raw = headers.get(name);
    if (raw) collect(safeJson(raw));
  }
  const buc = headers.get('x-business-use-case-usage');
  if (buc) {
    for (const entries of Object.values(safeJson(buc))) {
      if (Array.isArray(entries)) for (const entry of entries) collect(entry as Record<string, unknown>);
    }
  }
  if (values.length === 0 && regain === undefined) return undefined;
  return { maxPercent: Math.max(0, ...values), regainSeconds: regain };
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function defaultHint(error: GraphErrorBody): string | undefined {
  switch (error.code) {
    case 190:
      return 'The access token is expired or invalid. Re-run the auth script for this platform.';
    case 4:
    case 17:
    case 32:
    case 613:
      return 'Meta rate limit reached. Wait before retrying; check usage in the App Dashboard.';
    case 10:
    case 200:
      return 'Missing permission. Check that the token has the scopes listed in references/setup.md and that the app has the access level it needs.';
    case 368:
      return 'Meta temporarily blocked this action for policy reasons. Do not retry automatically; review the account in Meta Business Suite.';
    default:
      return undefined;
  }
}
