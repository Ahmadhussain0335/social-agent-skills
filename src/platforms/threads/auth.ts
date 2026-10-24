import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { readSecretJson, writeSecretJson } from '../../shared/token-store';
import { finishPasteback, startPasteback } from '../meta/pasteback';

// Threads OAuth (separate app ID/secret from the Facebook app).
// https://developers.facebook.com/documentation/threads/get-started/get-access-tokens-and-permissions
// https://developers.facebook.com/documentation/threads/get-started/long-lived-tokens

export const THREADS_ENV = {
  appId: 'THREADS_APP_ID',
  appSecret: 'THREADS_APP_SECRET',
  redirectUri: 'THREADS_REDIRECT_URI',
} as const;

export const THREADS_GRAPH = 'https://graph.threads.net';
export const THREADS_VERSION = 'v1.0';
export const THREADS_SCOPES = ['threads_basic', 'threads_content_publish'];
// Requested only with --with-engagement, for social-inbox and social-analytics.
export const THREADS_ENGAGEMENT_SCOPES = ['threads_read_replies', 'threads_manage_replies', 'threads_manage_insights'];

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ThreadsTokens {
  accessToken: string;
  userId: string;
  obtainedAt: string;
  expiresAt: string;
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value)
    throw new PlatformError(
      'THREADS_ENV_MISSING',
      `${name} is not set.`,
      'See the meta-auth skill references/setup.md.',
    );
  return value;
}

export function threadsTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(platformDir('meta', env), 'threads.json');
}

export function startThreadsLogin(env: NodeJS.ProcessEnv = process.env, withEngagement = false): string {
  return startPasteback(
    'threads',
    'https://threads.com/oauth/authorize',
    {
      client_id: need(env, THREADS_ENV.appId),
      scope: [...THREADS_SCOPES, ...(withEngagement ? THREADS_ENGAGEMENT_SCOPES : [])].join(','),
    },
    need(env, THREADS_ENV.redirectUri),
    env,
  );
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export async function finishThreadsLogin(
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<ThreadsTokens> {
  const { code, redirectUri } = finishPasteback('threads', pastedUrl, env);
  const appSecret = need(env, THREADS_ENV.appSecret);
  const short = await json(
    fetchImpl(`${THREADS_GRAPH}/oauth/access_token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: need(env, THREADS_ENV.appId),
        client_secret: appSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      }).toString(),
    }),
  );
  // Short-lived tokens last one hour; exchange immediately for a 60-day token.
  const long = await json(
    fetchImpl(
      `${THREADS_GRAPH}/access_token?${new URLSearchParams({
        grant_type: 'th_exchange_token',
        client_secret: appSecret,
        access_token: String(short.access_token),
      })}`,
    ),
  );
  const tokens = toTokens(String(long.access_token), String(short.user_id), Number(long.expires_in));
  writeSecretJson(threadsTokenPath(env), tokens);
  return tokens;
}

/** Long-lived tokens can be refreshed once they are 24 hours old and not yet expired. */
export async function refreshThreadsToken(
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
  now = Date.now(),
): Promise<ThreadsTokens> {
  const current = loadThreadsTokens(env, now);
  if (now - Date.parse(current.obtainedAt) < DAY_MS) return current;
  const res = await json(
    fetchImpl(
      `${THREADS_GRAPH}/refresh_access_token?${new URLSearchParams({ grant_type: 'th_refresh_token', access_token: current.accessToken })}`,
    ),
  );
  const tokens = toTokens(String(res.access_token), current.userId, Number(res.expires_in), now);
  writeSecretJson(threadsTokenPath(env), tokens);
  return tokens;
}

export function loadThreadsTokens(env: NodeJS.ProcessEnv = process.env, now = Date.now()): ThreadsTokens {
  const tokens = readSecretJson<ThreadsTokens>(threadsTokenPath(env));
  if (!tokens?.accessToken) {
    throw new PlatformError(
      'THREADS_NOT_AUTHORISED',
      'No Threads sign-in found.',
      'Run the meta-auth skill: node scripts/auth.mjs --platform threads --start, then --finish.',
    );
  }
  if (Date.parse(tokens.expiresAt) <= now) {
    throw new PlatformError(
      'THREADS_TOKEN_EXPIRED',
      'The Threads token has expired and cannot be refreshed.',
      'Sign in again with the meta-auth skill (--platform threads --start).',
    );
  }
  return tokens;
}

/** True when the token should be refreshed before use (less than 7 days left). */
export function needsRefresh(tokens: ThreadsTokens, now = Date.now()): boolean {
  return Date.parse(tokens.expiresAt) - now < 7 * DAY_MS && now - Date.parse(tokens.obtainedAt) >= DAY_MS;
}

function toTokens(accessToken: string, userId: string, expiresIn: number, now = Date.now()): ThreadsTokens {
  const seconds = Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : 60 * 24 * 60 * 60;
  return {
    accessToken,
    userId,
    obtainedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + seconds * 1000).toISOString(),
  };
}

async function json(response: Promise<Response>): Promise<Record<string, unknown>> {
  const res = await response;
  const body = (await res.json()) as Record<string, unknown> & { error?: { message?: string }; error_message?: string };
  if (!res.ok || body.error || body.error_message) {
    throw new PlatformError(
      'THREADS_AUTH_EXCHANGE',
      body.error?.message ?? body.error_message ?? `HTTP ${res.status}`,
      'Check THREADS_APP_ID and THREADS_APP_SECRET (the Threads pair, not the Facebook app pair) and that THREADS_REDIRECT_URI exactly matches the registered redirect URI.',
    );
  }
  return body;
}
