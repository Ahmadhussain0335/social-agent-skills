import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { readSecretJson, writeSecretJson } from '../../shared/token-store';
import { GRAPH_FACEBOOK, graphVersion } from './config';
import { GraphClient, type GraphErrorBody } from './graph';
import { finishPasteback, startPasteback } from './pasteback';

// Facebook Login (for Business) covering Facebook Pages and Instagram professional accounts
// linked to those Pages. Page tokens derived from a long-lived user token do not expire.
// https://developers.facebook.com/docs/facebook-login/guides/access-tokens/get-long-lived

export const META_ENV = {
  appId: 'META_APP_ID',
  appSecret: 'META_APP_SECRET',
  redirectUri: 'META_REDIRECT_URI',
  configId: 'META_LOGIN_CONFIG_ID',
} as const;

export const FACEBOOK_SCOPES = [
  'pages_show_list',
  'pages_read_engagement',
  'pages_manage_posts',
  'instagram_basic',
  'instagram_content_publish',
];

export interface PageAccount {
  id: string;
  name: string;
  accessToken: string;
  tasks: string[];
  instagram?: { id: string; username?: string };
}

export interface FacebookTokens {
  obtainedAt: string;
  userTokenExpiresAt?: string;
  pages: PageAccount[];
}

function need(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value) {
    throw new PlatformError('META_ENV_MISSING', `${name} is not set.`, 'See the meta-auth skill references/setup.md.');
  }
  return value;
}

export function facebookTokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(platformDir('meta', env), 'facebook.json');
}

export function startFacebookLogin(env: NodeJS.ProcessEnv = process.env): string {
  const configId = env[META_ENV.configId];
  return startPasteback(
    'facebook',
    `https://www.facebook.com/${graphVersion(env)}/dialog/oauth`,
    {
      client_id: need(env, META_ENV.appId),
      // Facebook Login for Business uses a configuration instead of a scope list.
      ...(configId ? { config_id: configId } : { scope: FACEBOOK_SCOPES.join(',') }),
    },
    need(env, META_ENV.redirectUri),
    env,
  );
}

export type FetchLike = (url: string) => Promise<Response>;

/** Exchanges the code, upgrades to a long-lived token and stores non-expiring Page tokens. */
export async function finishFacebookLogin(
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: FetchLike = fetch,
): Promise<FacebookTokens> {
  const { code, redirectUri } = finishPasteback('facebook', pastedUrl, env);
  const appId = need(env, META_ENV.appId);
  const appSecret = need(env, META_ENV.appSecret);
  const base = `${GRAPH_FACEBOOK}/${graphVersion(env)}`;

  const short = await getJson(
    fetchImpl,
    `${base}/oauth/access_token?${new URLSearchParams({ client_id: appId, client_secret: appSecret, redirect_uri: redirectUri, code })}`,
  );
  const long = await getJson(
    fetchImpl,
    `${base}/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecret,
      fb_exchange_token: String(short.access_token),
    })}`,
  );

  const client = new GraphClient({
    baseUrl: GRAPH_FACEBOOK,
    version: graphVersion(env),
    accessToken: String(long.access_token),
    appSecret,
  });
  const accounts = (await client.get('me/accounts', {
    fields: 'id,name,access_token,tasks,instagram_business_account{id,username}',
    limit: 100,
  })) as {
    data?: Array<{
      id: string;
      name: string;
      access_token: string;
      tasks?: string[];
      instagram_business_account?: { id: string; username?: string };
    }>;
  };

  const tokens: FacebookTokens = {
    obtainedAt: new Date().toISOString(),
    userTokenExpiresAt:
      typeof long.expires_in === 'number' ? new Date(Date.now() + long.expires_in * 1000).toISOString() : undefined,
    pages: (accounts.data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      tasks: p.tasks ?? [],
      instagram: p.instagram_business_account,
    })),
  };
  writeSecretJson(facebookTokenPath(env), tokens);
  return tokens;
}

export function loadFacebookTokens(env: NodeJS.ProcessEnv = process.env): FacebookTokens {
  const tokens = readSecretJson<FacebookTokens>(facebookTokenPath(env));
  if (!tokens?.pages) {
    throw new PlatformError(
      'META_NOT_AUTHORISED',
      'No Facebook/Instagram sign-in found.',
      'Run the meta-auth skill: node scripts/auth.mjs --platform facebook --start, then --finish.',
    );
  }
  return tokens;
}

/** Picks a Page by id, or the only Page when there is exactly one. */
export function selectPage(tokens: FacebookTokens, pageId?: string): PageAccount {
  if (pageId) {
    const page = tokens.pages.find((p) => p.id === pageId);
    if (!page) throw new PlatformError('META_PAGE_UNKNOWN', `Page ${pageId} is not among the authorised Pages.`);
    return page;
  }
  if (tokens.pages.length === 1) return tokens.pages[0] as PageAccount;
  throw new PlatformError(
    'META_PAGE_AMBIGUOUS',
    tokens.pages.length === 0
      ? 'No Facebook Pages were authorised.'
      : 'Several Pages are authorised; set options.pageId in post.json.',
    `Authorised Pages: ${tokens.pages.map((p) => `${p.name} (${p.id})`).join(', ') || 'none'}`,
  );
}

export function selectInstagram(tokens: FacebookTokens, igUserId?: string): { page: PageAccount; igUserId: string } {
  const linked = tokens.pages.filter((p) => p.instagram?.id);
  const match = igUserId
    ? linked.find((p) => p.instagram?.id === igUserId)
    : linked.length === 1
      ? linked[0]
      : undefined;
  if (!match?.instagram) {
    throw new PlatformError(
      'IG_ACCOUNT_UNKNOWN',
      linked.length === 0
        ? 'No Instagram professional account is linked to the authorised Pages.'
        : 'Several Instagram accounts are linked; set options.instagramAccountId in post.json.',
      'Instagram publishing needs a Business or Creator account linked to a Facebook Page. Personal accounts are not supported by the API.',
    );
  }
  return { page: match, igUserId: match.instagram.id };
}

async function getJson(fetchImpl: FetchLike, url: string): Promise<Record<string, unknown>> {
  const res = await fetchImpl(url);
  const json = (await res.json()) as Record<string, unknown> & { error?: GraphErrorBody };
  if (!res.ok || json.error) {
    throw new PlatformError(
      'META_AUTH_EXCHANGE',
      json.error?.message ?? `Token exchange failed (HTTP ${res.status})`,
      'Check META_APP_ID, META_APP_SECRET and that META_REDIRECT_URI exactly matches a Valid OAuth Redirect URI in the app settings.',
    );
  }
  return json;
}
