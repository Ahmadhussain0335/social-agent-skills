import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { PlatformError } from '../../shared/errors';
import { log } from '../../shared/log';
import { createPkce, loopbackAuthorize } from '../../shared/oauth';
import { isTooOpen, readSecretJson, writeSecretJson } from '../../shared/token-store';

// Installed-app OAuth for Google APIs (YouTube, Business Profile) without Google's client
// libraries: loopback redirect on a free port, PKCE, and refresh through the token endpoint.
// https://developers.google.com/identity/protocols/oauth2/native-app
// Tokens keep the field names Google's libraries used, so existing token files still work.

const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

export interface GoogleToken {
  access_token: string;
  refresh_token?: string;
  /** Milliseconds since epoch. */
  expiry_date?: number;
  scope?: string;
  token_type?: string;
}

export interface DesktopClient {
  clientId: string;
  clientSecret: string;
}

export function readDesktopClient(path: string | undefined, envName: string): DesktopClient {
  if (!path) {
    throw new PlatformError(
      'GOOGLE_CLIENT_SECRET_MISSING',
      `${envName} is not set.`,
      'Create an OAuth client of type "Desktop app" in your own Google Cloud project, download its JSON, store it outside any repository and point the variable at it. See references/setup.md.',
    );
  }
  if (!existsSync(path)) {
    throw new PlatformError('GOOGLE_CLIENT_SECRET_MISSING', `${envName} points to a missing file: ${path}`);
  }
  if (isTooOpen(path)) log.warn(`${path} is readable by other users. Run: chmod 600 "${path}"`);
  const installed = (
    JSON.parse(readFileSync(path, 'utf8')) as { installed?: { client_id: string; client_secret: string } }
  ).installed;
  if (!installed) {
    throw new PlatformError(
      'GOOGLE_CLIENT_TYPE',
      'The OAuth client file is not a "Desktop app" client.',
      'In Google Cloud console > Clients, create a client of type "Desktop app" and download its JSON. Web clients cannot use the local loopback redirect.',
    );
  }
  return { clientId: installed.client_id, clientSecret: installed.client_secret };
}

type FetchLike = typeof fetch;

async function tokenRequest(form: Record<string, string>, fetchImpl: FetchLike): Promise<Record<string, unknown>> {
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString(),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok || body.error) {
    // Shape matches what youtube/errors.ts reads, so invalid_grant maps to a clear hint.
    const error = new Error(String(body.error_description ?? body.error ?? `HTTP ${res.status}`)) as Error & {
      response?: unknown;
    };
    error.response = { status: res.status, data: { error: body.error } };
    throw error;
  }
  return body;
}

function toToken(body: Record<string, unknown>, previous?: GoogleToken): GoogleToken {
  const expiresIn = Number(body.expires_in);
  return {
    access_token: String(body.access_token),
    refresh_token: (body.refresh_token as string | undefined) ?? previous?.refresh_token,
    expiry_date: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined,
    scope: (body.scope as string | undefined) ?? previous?.scope,
    token_type: (body.token_type as string | undefined) ?? previous?.token_type,
  };
}

export interface SignInOptions {
  client: DesktopClient;
  scopes: readonly string[];
  tokenFile: string;
  openBrowser?: boolean;
  fetchImpl?: FetchLike;
}

/** Browser sign-in; writes the token file with mode 0600 and returns its path. */
export async function signInGoogle(opts: SignInOptions): Promise<string> {
  const pkce = createPkce();
  const { code, redirectUri } = await loopbackAuthorize({
    platform: 'google',
    authorizeUrl: AUTHORIZE_URL,
    params: {
      client_id: opts.client.clientId,
      scope: opts.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    },
    redirectUri: 'http://127.0.0.1:0',
    pkce,
    onUrl: (url) => {
      log.info(`Open this URL in your browser and sign in with the Google account to authorise:\n\n${url}\n`);
      if (opts.openBrowser !== false) openUrl(url);
    },
  });
  const body = await tokenRequest(
    {
      code,
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
      code_verifier: pkce.verifier,
    },
    opts.fetchImpl ?? fetch,
  );
  const token = toToken(body);
  if (!token.refresh_token) {
    throw new PlatformError(
      'GOOGLE_NO_REFRESH_TOKEN',
      'Google did not return a refresh token.',
      'Remove this app under myaccount.google.com > Security > Third-party access, then sign in again.',
    );
  }
  writeSecretJson(opts.tokenFile, token);
  return opts.tokenFile;
}

export interface AccessTokenOptions {
  client: DesktopClient;
  tokenFile: string;
  notSignedInHint: string;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Returns a valid access token, refreshing it (and saving the result) when it expires within 5 minutes. */
export async function googleAccessToken(opts: AccessTokenOptions): Promise<string> {
  const token = readSecretJson<GoogleToken>(opts.tokenFile);
  if (!token?.refresh_token) {
    throw new PlatformError('GOOGLE_NOT_AUTHORISED', 'Not signed in to Google for this skill.', opts.notSignedInHint);
  }
  if (isTooOpen(opts.tokenFile))
    log.warn(`${opts.tokenFile} is readable by other users. Run: chmod 600 "${opts.tokenFile}"`);
  const now = (opts.now ?? Date.now)();
  if (token.access_token && token.expiry_date && token.expiry_date - now > 5 * 60_000) return token.access_token;

  const body = await tokenRequest(
    {
      client_id: opts.client.clientId,
      client_secret: opts.client.clientSecret,
      refresh_token: token.refresh_token,
      grant_type: 'refresh_token',
    },
    opts.fetchImpl ?? fetch,
  );
  const fresh = toToken(body, token);
  writeSecretJson(opts.tokenFile, fresh);
  return fresh.access_token;
}

function openUrl(url: string): void {
  const [cmd, args] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
        : ['xdg-open', [url]];
  try {
    spawn(cmd, args as string[], { stdio: 'ignore', detached: true })
      .on('error', () => {})
      .unref();
  } catch {
    // The URL is printed; opening the browser is a convenience.
  }
}
