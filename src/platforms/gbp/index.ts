import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { CodeChallengeMethod, type Credentials, OAuth2Client } from 'google-auth-library';
import { ApiClient } from '../../shared/api';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { log } from '../../shared/log';
import { isRemote, type PostDraft } from '../../shared/post-project';
import { readSecretJson, writeSecretJson } from '../../shared/token-store';
import type { CheckResult } from '../meta/facebook';
import { type InboxComment, registerPostPlatform } from '../posting';

// Google Business Profile. Each user's Cloud project must be approved for the API first
// (https://developers.google.com/my-business/content/prereqs): quota 0 means not approved.
// Local posts: My Business API v4 localPosts. Reviews: v4 reviews. Metrics: Performance API.

export const GBP_ENV = { clientSecretPath: 'GBP_CLIENT_SECRET_PATH' } as const;
export const GBP_SCOPE = 'https://www.googleapis.com/auth/business.manage';
const V4 = 'https://mybusiness.googleapis.com/v4';
const CTA_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];

function clientSecret(env: NodeJS.ProcessEnv): { clientId: string; clientSecret: string } {
  const path = env[GBP_ENV.clientSecretPath] || env.YT_CLIENT_SECRET_PATH;
  if (!path || !existsSync(path)) {
    throw new PlatformError(
      'GBP_CLIENT_SECRET_MISSING',
      'Set GBP_CLIENT_SECRET_PATH (or YT_CLIENT_SECRET_PATH) to a Desktop app OAuth client JSON.',
      'See the google-business-post skill references/setup.md.',
    );
  }
  const installed = (
    JSON.parse(readFileSync(path, 'utf8')) as { installed?: { client_id: string; client_secret: string } }
  ).installed;
  if (!installed) throw new PlatformError('GBP_CLIENT_TYPE', 'The OAuth client must be of type "Desktop app".');
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

function tokenFile(env: NodeJS.ProcessEnv): string {
  return join(platformDir('gbp', env), 'token.json');
}

/** Loopback sign-in with PKCE, as Google requires for installed apps. */
export async function signInGbp(env: NodeJS.ProcessEnv = process.env, openBrowser = true): Promise<string> {
  const { clientId, clientSecret: secret } = clientSecret(env);
  const server = createServer();
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  const redirectUri = `http://127.0.0.1:${port}`;
  const auth = new OAuth2Client({ clientId, clientSecret: secret, redirectUri });
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
  const state = randomBytes(16).toString('hex');
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [GBP_SCOPE],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });
  log.info(`Open this URL and sign in with the Google account that manages the Business Profile:\n\n${url}\n`);
  if (openBrowser)
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PlatformError('GBP_AUTH_TIMEOUT', 'Timed out waiting for sign-in.')),
        5 * 60_000,
      );
      server.on('request', (req, res) => {
        const p = new URL(req.url ?? '/', redirectUri).searchParams;
        if (!p.has('code') && !p.has('error')) return void res.writeHead(404).end();
        clearTimeout(timer);
        res.writeHead(200, { 'content-type': 'text/plain' }).end('Signed in. You can close this tab.');
        if (p.get('state') !== state) reject(new PlatformError('GBP_AUTH_STATE', 'OAuth state mismatch.'));
        else if (!p.has('code')) reject(new PlatformError('GBP_AUTH_DENIED', String(p.get('error'))));
        else resolve(p.get('code') as string);
      });
    });
    const { tokens } = await auth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    writeSecretJson(tokenFile(env), tokens);
    return tokenFile(env);
  } finally {
    server.close();
  }
}

export function gbpClient(base: string, env: NodeJS.ProcessEnv = process.env, fetchImpl?: typeof fetch): ApiClient {
  const tokens = readSecretJson<Credentials>(tokenFile(env));
  if (!tokens?.refresh_token)
    throw new PlatformError(
      'GBP_NOT_AUTHORISED',
      'Not signed in to Google Business Profile.',
      'Run the google-business-post auth script.',
    );
  const { clientId, clientSecret: secret } = clientSecret(env);
  const auth = new OAuth2Client({ clientId, clientSecret: secret });
  auth.setCredentials(tokens);
  auth.on('tokens', (fresh) =>
    writeSecretJson(tokenFile(env), {
      ...tokens,
      ...fresh,
      refresh_token: fresh.refresh_token ?? tokens.refresh_token,
    }),
  );
  return new ApiClient({
    base,
    fetchImpl,
    token: async () => String((await auth.getAccessToken()).token),
    onError: (status, body) => {
      const message = (body as { error?: { message?: string; status?: string } }).error?.message ?? `HTTP ${status}`;
      const hint =
        status === 429 || /quota/i.test(message)
          ? 'Your Cloud project may not be approved for the Business Profile APIs yet (quota 0). Apply via the GBP API access form.'
          : status === 403
            ? 'The signed-in account cannot manage this location, or the API is not enabled.'
            : undefined;
      return new PlatformError(`GBP_${status}`, message, hint);
    },
  });
}

export function checkGbpPost(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const o = draft.options ?? {};
  if (draft.platform !== 'google-business') errors.push('platform must be "google-business"');
  if (!['standard', 'event', 'offer'].includes(draft.kind)) errors.push('kind must be standard, event or offer');
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(String(o.location ?? '')))
    errors.push('options.location must be "accounts/<id>/locations/<id>" (list them with the auth script --locations)');
  if (!draft.text?.trim()) errors.push('text (summary) is required');
  if ((draft.text ?? '').length > 1500) warnings.push('summaries over 1,500 characters are usually rejected');
  const cta = o.cta as { actionType?: string; url?: string } | undefined;
  if (cta && !CTA_TYPES.includes(String(cta.actionType)))
    errors.push(`options.cta.actionType must be one of ${CTA_TYPES.join(', ')}`);
  if (cta && cta.actionType !== 'CALL' && !cta.url) errors.push('options.cta.url is required for this call to action');
  if ((draft.kind === 'event' || draft.kind === 'offer') && !o.event)
    errors.push(`${draft.kind} posts need options.event { title, schedule }`);
  if ((draft.media ?? []).some((m) => !isRemote(m.source) || m.type !== 'image'))
    errors.push('media must be photos at public https URLs');
  if (draft.scheduledAt) errors.push('local posts cannot be scheduled via the API; use content-calendar');
  return { ok: errors.length === 0, errors, warnings };
}

export async function publishGbp(client: ApiClient, draft: PostDraft): Promise<Record<string, unknown>> {
  const o = draft.options ?? {};
  const res = await client.post<{ name: string; searchUrl?: string; state?: string }>(`/${o.location}/localPosts`, {
    languageCode: (o.lang as string | undefined) ?? 'en',
    summary: draft.text,
    topicType: draft.kind.toUpperCase(),
    ...(o.cta ? { callToAction: o.cta } : {}),
    ...((draft.media ?? []).length
      ? { media: (draft.media ?? []).map((m) => ({ mediaFormat: 'PHOTO', sourceUrl: m.source })) }
      : {}),
    ...(o.event ? { event: o.event } : {}),
    ...(o.offer ? { offer: o.offer } : {}),
  });
  return { id: res.body.name, url: res.body.searchUrl, state: res.body.state };
}

function locationOf(postName: string): { account: string; location: string } {
  const m = /^(accounts\/[^/]+)\/(locations\/[^/]+)/.exec(postName);
  if (!m) throw new PlatformError('GBP_POST_ID', `Not a local post name: ${postName}`);
  return { account: m[1] as string, location: m[2] as string };
}

export async function listLocations(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Array<{ name: string; title: string }>> {
  const accounts = await gbpClient('https://mybusinessaccountmanagement.googleapis.com/v1', env).get<{
    accounts?: Array<{ name: string }>;
  }>('/accounts');
  const out: Array<{ name: string; title: string }> = [];
  const info = gbpClient('https://mybusinessbusinessinformation.googleapis.com/v1', env);
  for (const a of accounts.body.accounts ?? []) {
    const locs = await info.get<{ locations?: Array<{ name: string; title: string }> }>(
      `/${a.name}/locations?readMask=name,title&pageSize=100`,
    );
    for (const l of locs.body.locations ?? []) out.push({ name: `${a.name}/${l.name}`, title: l.title });
  }
  return out;
}

registerPostPlatform({
  id: 'google-business',
  label: 'Google Business Profile',
  kinds: ['standard', 'event', 'offer'],
  textLimit: 1500,
  scheduling: false,
  notes: [
    'Needs Google approval for the Business Profile APIs (profile verified 60+ days, business website).',
    'Photos must be at public https URLs.',
    'Calls to action: BOOK, ORDER, SHOP, LEARN_MORE, SIGN_UP, CALL.',
  ],
  check: (draft) => checkGbpPost(draft),
  publish: (_dir, draft, env) => publishGbp(gbpClient(V4, env), draft),
  async metrics(postId, env) {
    const { location } = locationOf(postId);
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
    const d = (x: Date, p: string) =>
      `dailyRange.${p}.year=${x.getUTCFullYear()}&dailyRange.${p}.month=${x.getUTCMonth() + 1}&dailyRange.${p}.day=${x.getUTCDate()}`;
    const metrics = [
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'WEBSITE_CLICKS',
      'CALL_CLICKS',
      'BUSINESS_DIRECTION_REQUESTS',
    ];
    const res = await gbpClient('https://businessprofileperformance.googleapis.com/v1', env).get<{
      multiDailyMetricTimeSeries?: Array<{
        dailyMetricTimeSeries?: Array<{
          dailyMetric: string;
          timeSeries?: { datedValues?: Array<{ value?: string }> };
        }>;
      }>;
    }>(
      `/${location}:fetchMultiDailyMetricsTimeSeries?${metrics.map((m) => `dailyMetrics=${m}`).join('&')}&${d(start, 'start_date')}&${d(end, 'end_date')}`,
    );
    const totals: Record<string, number> = {};
    for (const group of res.body.multiDailyMetricTimeSeries ?? []) {
      for (const series of group.dailyMetricTimeSeries ?? []) {
        totals[`${series.dailyMetric.toLowerCase()}_30d`] = (series.timeSeries?.datedValues ?? []).reduce(
          (s, v) => s + Number(v.value ?? 0),
          0,
        );
      }
    }
    return totals;
  },
  async comments(postId, env) {
    const { account, location } = locationOf(postId);
    const res = await gbpClient(V4, env).get<{
      reviews?: Array<{
        reviewId: string;
        reviewer?: { displayName?: string };
        comment?: string;
        createTime?: string;
        starRating?: string;
        reviewReply?: unknown;
      }>;
    }>(`/${account}/${location}/reviews?pageSize=50`);
    return (res.body.reviews ?? [])
      .filter((r) => !r.reviewReply)
      .map(
        (r): InboxComment => ({
          platform: 'google-business',
          postId,
          commentId: `${account}/${location}/reviews/${r.reviewId}`,
          author: r.reviewer?.displayName ?? 'Google user',
          text: `[${r.starRating ?? '?'} stars] ${r.comment ?? ''}`.trim(),
          createdAt: r.createTime ?? '',
        }),
      );
  },
  async reply(comment, text, env) {
    if (Buffer.byteLength(text) > 4096)
      throw new PlatformError('GBP_REPLY_LENGTH', 'Review replies are limited to 4096 bytes.');
    await gbpClient(V4, env).request('PUT', `/${comment.commentId}/reply`, { comment: text });
    return { id: `${comment.commentId}/reply` };
  },
});
