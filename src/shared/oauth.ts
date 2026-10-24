import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { platformDir } from './config-paths';
import { PlatformError } from './errors';
import { log } from './log';
import { readSecretJson, writeSecretJson } from './token-store';

// Generic OAuth helpers shared by platforms that are not Google or Meta.
// Two ways to receive the authorization code:
// - paste-back: the provider requires an HTTPS redirect (LinkedIn, Pinterest); the user
//   pastes the URL they land on. Split into start/finish so agents can drive it.
// - loopback: the provider allows http://127.0.0.1 for desktop apps (X, TikTok); a local
//   listener receives the code, so nothing is pasted.

const PENDING_MAX_AGE_MS = 60 * 60 * 1000;

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** S256 PKCE. TikTok's desktop flow expects the SHA-256 as hex instead of base64url. */
export function createPkce(encoding: 'base64url' | 'hex' = 'base64url'): Pkce {
  const verifier = randomBytes(48).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest(encoding) };
}

interface Pending {
  state: string;
  redirectUri: string;
  verifier?: string;
  createdAt: number;
}

function pendingPath(platform: string, env: NodeJS.ProcessEnv): string {
  return join(platformDir(platform, env), 'pending-auth.json');
}

export interface AuthorizeRequest {
  platform: string;
  authorizeUrl: string;
  params: Record<string, string | undefined>;
  redirectUri: string;
  pkce?: Pkce;
  env?: NodeJS.ProcessEnv;
}

function buildUrl(req: AuthorizeRequest, state: string): string {
  const url = new URL(req.authorizeUrl);
  const params: Record<string, string | undefined> = {
    ...req.params,
    redirect_uri: req.redirectUri,
    state,
    response_type: 'code',
    ...(req.pkce ? { code_challenge: req.pkce.challenge, code_challenge_method: 'S256' } : {}),
  };
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

export function startPasteback(req: AuthorizeRequest): string {
  const env = req.env ?? process.env;
  const state = randomBytes(16).toString('hex');
  writeSecretJson(pendingPath(req.platform, env), {
    state,
    redirectUri: req.redirectUri,
    verifier: req.pkce?.verifier,
    createdAt: Date.now(),
  } satisfies Pending);
  return buildUrl(req, state);
}

export function finishPasteback(
  platform: string,
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: string; redirectUri: string; verifier?: string } {
  const pending = readSecretJson<Pending>(pendingPath(platform, env));
  if (!pending?.state)
    throw new PlatformError('AUTH_NOT_STARTED', 'No sign-in in progress. Run the auth script with --start first.');
  if (Date.now() - pending.createdAt > PENDING_MAX_AGE_MS) {
    throw new PlatformError('AUTH_EXPIRED', 'The sign-in link is older than 1 hour. Start again.');
  }
  let url: URL;
  try {
    url = new URL(pastedUrl.trim());
  } catch {
    throw new PlatformError('AUTH_BAD_URL', 'Paste the full URL from the browser address bar after signing in.');
  }
  const error = url.searchParams.get('error');
  if (error)
    throw new PlatformError(
      'AUTH_DENIED',
      `Sign-in was not completed: ${url.searchParams.get('error_description') ?? error}`,
    );
  if (url.searchParams.get('state') !== pending.state) {
    throw new PlatformError(
      'AUTH_STATE',
      'The pasted URL does not belong to this sign-in (state mismatch). Start again.',
    );
  }
  const code = url.searchParams.get('code');
  if (!code) throw new PlatformError('AUTH_NO_CODE', 'The pasted URL has no "code" parameter.');
  writeSecretJson(pendingPath(platform, env), {});
  return { code, redirectUri: pending.redirectUri, verifier: pending.verifier };
}

/** Listens on the loopback redirect URI and resolves with the authorization code. */
export async function loopbackAuthorize(
  req: AuthorizeRequest & { timeoutMs?: number; onUrl?: (url: string) => void },
): Promise<{ code: string; redirectUri: string }> {
  const redirect = new URL(req.redirectUri);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(redirect.hostname) || redirect.protocol !== 'http:') {
    throw new PlatformError(
      'AUTH_REDIRECT',
      `Loopback sign-in needs an http://127.0.0.1:<port>/... redirect URI, got ${req.redirectUri}`,
    );
  }
  const state = randomBytes(16).toString('hex');
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', (e) =>
      reject(new PlatformError('AUTH_PORT', `Cannot listen on ${redirect.host}: ${e.message}`)),
    );
    server.listen(Number(redirect.port || 80), redirect.hostname.replace(/^\[|\]$/g, ''), resolve);
  });
  const url = buildUrl(req, state);
  (req.onUrl ?? ((u) => log.info(`Open this URL in your browser to sign in:\n\n${u}\n`)))(url);
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PlatformError('AUTH_TIMEOUT', 'Timed out waiting for the browser sign-in.')),
        req.timeoutMs ?? 5 * 60_000,
      );
      server.on('request', (r, res) => {
        const params = new URL(r.url ?? '/', req.redirectUri).searchParams;
        if (!params.has('code') && !params.has('error')) {
          res.writeHead(404).end();
          return;
        }
        clearTimeout(timer);
        const ok = params.get('state') === state && params.has('code');
        res
          .writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' })
          .end(ok ? 'Signed in. You can close this tab.' : 'Sign-in failed. Return to the terminal.');
        if (params.get('state') !== state) reject(new PlatformError('AUTH_STATE', 'OAuth state mismatch; aborted.'));
        else if (!params.has('code'))
          reject(new PlatformError('AUTH_DENIED', `Sign-in denied: ${params.get('error')}`));
        else resolve(params.get('code') as string);
      });
    });
    return { code, redirectUri: req.redirectUri };
  } finally {
    server.close();
  }
}

export interface StoredToken {
  accessToken: string;
  refreshToken?: string;
  /** ISO time the access token expires. */
  expiresAt?: string;
  /** ISO time the refresh token expires, when the provider says. */
  refreshExpiresAt?: string;
  obtainedAt: string;
  extra?: Record<string, string>;
}

export function tokenPath(platform: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(platformDir(platform, env), 'token.json');
}

export function saveToken(platform: string, token: StoredToken, env: NodeJS.ProcessEnv = process.env): void {
  writeSecretJson(tokenPath(platform, env), token);
}

export function loadToken(platform: string, env: NodeJS.ProcessEnv = process.env): StoredToken {
  const token = readSecretJson<StoredToken>(tokenPath(platform, env));
  if (!token?.accessToken) {
    throw new PlatformError(
      'AUTH_REQUIRED',
      `Not signed in to ${platform}.`,
      `Run the ${platform} skill's auth script first (node scripts/auth.mjs).`,
    );
  }
  return token;
}

/** Returns a valid access token, refreshing it when it expires within 5 minutes. */
export async function accessToken(
  platform: string,
  refresh: ((token: StoredToken) => Promise<StoredToken>) | undefined,
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now(),
): Promise<string> {
  const token = loadToken(platform, env);
  const expiresAt = token.expiresAt ? Date.parse(token.expiresAt) : Number.POSITIVE_INFINITY;
  if (expiresAt - now > 5 * 60_000) return token.accessToken;
  if (!refresh || !token.refreshToken) {
    throw new PlatformError(
      'AUTH_EXPIRED',
      `The ${platform} sign-in has expired.`,
      `Sign in again with the ${platform} auth script.`,
    );
  }
  const fresh = await refresh(token);
  saveToken(platform, fresh, env);
  return fresh.accessToken;
}

export function expiresIn(seconds: unknown, now = Date.now()): string | undefined {
  const n = Number(seconds);
  return Number.isFinite(n) && n > 0 ? new Date(now + n * 1000).toISOString() : undefined;
}

/** POSTs a form and returns JSON, turning provider errors into PlatformError. */
export async function postForm(
  url: string,
  form: Record<string, string | undefined>,
  headers: Record<string, string> = {},
  fetchImpl: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) if (v !== undefined) body.set(k, v);
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json', ...headers },
    body: body.toString(),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    // fall through with the raw text in the error
  }
  if (!res.ok || json.error) {
    const message = String(
      json.error_description ?? json.message ?? json.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`,
    );
    throw new PlatformError('AUTH_TOKEN_REQUEST', `Token request failed: ${message}`);
  }
  return json;
}
