import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { youtube, type youtube_v3 } from '@googleapis/youtube';
import { CodeChallengeMethod, type Credentials, OAuth2Client } from 'google-auth-library';
import { PlatformError } from '../../shared/errors';
import { log } from '../../shared/log';
import { isTooOpen, readSecretJson, writeSecretJson } from '../../shared/token-store';
import { clientSecretPath, tokenPath, YT_ENV, YT_SCOPES } from './config';

interface ClientSecretFile {
  installed?: { client_id: string; client_secret: string };
  web?: unknown;
}

export function readClientSecret(env: NodeJS.ProcessEnv = process.env): { clientId: string; clientSecret: string } {
  const path = clientSecretPath(env);
  if (!existsSync(path)) {
    throw new PlatformError('YT_CLIENT_SECRET_MISSING', `${YT_ENV.clientSecretPath} points to a missing file: ${path}`);
  }
  if (isTooOpen(path)) log.warn(`${path} is readable by other users. Run: chmod 600 "${path}"`);
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as ClientSecretFile;
  if (!parsed.installed) {
    throw new PlatformError(
      'YT_CLIENT_TYPE',
      'The OAuth client file is not a "Desktop app" client.',
      'In Google Cloud console > Clients, create a client of type "Desktop app" and download its JSON. Web clients cannot use the local loopback redirect.',
    );
  }
  return { clientId: parsed.installed.client_id, clientSecret: parsed.installed.client_secret };
}

/** Authorised client for upload calls. Refreshed tokens are written back with mode 0600. */
export function authorisedClient(env: NodeJS.ProcessEnv = process.env): youtube_v3.Youtube {
  const { clientId, clientSecret } = readClientSecret(env);
  const path = tokenPath(env);
  const tokens = readSecretJson<Credentials>(path);
  if (!tokens?.refresh_token) {
    throw new PlatformError(
      'YT_NOT_AUTHORISED',
      'No YouTube OAuth token found.',
      'Ask the user to run the socialkit-youtube-upload auth script in their own terminal: node scripts/auth.mjs',
    );
  }
  if (isTooOpen(path)) log.warn(`${path} is readable by other users. Run: chmod 600 "${path}"`);

  const auth = new OAuth2Client({ clientId, clientSecret });
  auth.setCredentials(tokens);
  auth.on('tokens', (fresh) => {
    writeSecretJson(path, { ...tokens, ...fresh, refresh_token: fresh.refresh_token ?? tokens.refresh_token });
  });
  return youtube({ version: 'v3', auth });
}

export function apiKeyClient(env: NodeJS.ProcessEnv = process.env): youtube_v3.Youtube {
  const key = env[YT_ENV.apiKey];
  if (!key) {
    throw new PlatformError(
      'YT_API_KEY_MISSING',
      `${YT_ENV.apiKey} is not set.`,
      'Create an API key restricted to "YouTube Data API v3" in your Google Cloud project and export it as YT_API_KEY. See references/setup.md.',
    );
  }
  return youtube({ version: 'v3', auth: key });
}

export interface AuthFlowOptions {
  env?: NodeJS.ProcessEnv;
  openBrowser?: boolean;
  timeoutMs?: number;
}

/** Installed-app OAuth with a loopback redirect, PKCE and a state check. */
export async function runAuthFlow(opts: AuthFlowOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  const { clientId, clientSecret } = readClientSecret(env);
  const state = randomBytes(16).toString('hex');

  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Could not start the local OAuth listener');
  const redirectUri = `http://127.0.0.1:${address.port}`;

  const auth = new OAuth2Client({ clientId, clientSecret, redirectUri });
  const { codeVerifier, codeChallenge } = await auth.generateCodeVerifierAsync();
  const url = auth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [...YT_SCOPES],
    state,
    code_challenge_method: CodeChallengeMethod.S256,
    code_challenge: codeChallenge,
  });

  log.info(`Open this URL in your browser and sign in with the account that owns the channel:\n\n${url}\n`);
  if (opts.openBrowser !== false) openUrl(url);

  try {
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new PlatformError('YT_AUTH_TIMEOUT', 'Timed out waiting for the browser sign-in.')),
        opts.timeoutMs ?? 5 * 60_000,
      );
      server.on('request', (req, res) => {
        const params = new URL(req.url ?? '/', redirectUri).searchParams;
        if (!params.has('code') && !params.has('error')) {
          res.writeHead(404).end();
          return;
        }
        clearTimeout(timer);
        const ok = params.get('state') === state && params.has('code');
        res.writeHead(ok ? 200 : 400, { 'content-type': 'text/plain' });
        res.end(ok ? 'Authorised. You can close this tab.' : 'Authorisation failed. Return to the terminal.');
        if (params.get('state') !== state) reject(new PlatformError('YT_AUTH_STATE', 'OAuth state mismatch; aborted.'));
        else if (!params.has('code'))
          reject(new PlatformError('YT_AUTH_DENIED', `Authorisation denied: ${params.get('error')}`));
        else resolve(params.get('code') as string);
      });
    });

    const { tokens } = await auth.getToken({ code, codeVerifier, redirect_uri: redirectUri });
    if (!tokens.refresh_token) {
      throw new PlatformError(
        'YT_NO_REFRESH_TOKEN',
        'Google did not return a refresh token.',
        'Remove this app under myaccount.google.com > Security > Third-party access, then run the auth script again.',
      );
    }
    const path = tokenPath(env);
    writeSecretJson(path, tokens);
    return path;
  } finally {
    server.close();
  }
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
