import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { readSecretJson, writeSecretJson } from '../../shared/token-store';

// Paste-back OAuth: the user opens the authorize URL, signs in, and pastes the URL they are
// redirected to. Threads rejects localhost redirects and requires HTTPS, and Facebook's
// localhost exception is undocumented for 2026, so a loopback listener is not an option.
// The redirect page only has to exist on an HTTPS origin the user controls; the code is read
// from the address bar. Split into start/finish so agents without a terminal can drive it.

const MAX_AGE_MS = 60 * 60 * 1000;

interface Pending {
  state: string;
  redirectUri: string;
  createdAt: number;
}

function pendingPath(platform: string, env: NodeJS.ProcessEnv): string {
  return join(platformDir('meta', env), `pending-${platform}.json`);
}

export function startPasteback(
  platform: string,
  authorizeUrl: string,
  params: Record<string, string | undefined>,
  redirectUri: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const state = randomBytes(16).toString('hex');
  writeSecretJson(pendingPath(platform, env), { state, redirectUri, createdAt: Date.now() } satisfies Pending);
  const url = new URL(authorizeUrl);
  for (const [key, value] of Object.entries({ ...params, redirect_uri: redirectUri, state, response_type: 'code' })) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  return url.toString();
}

/** Validates state and age, and returns the authorization code from the pasted redirect URL. */
export function finishPasteback(
  platform: string,
  pastedUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): { code: string; redirectUri: string } {
  const pending = readSecretJson<Pending>(pendingPath(platform, env));
  if (!pending?.state)
    throw new PlatformError('META_AUTH_NOT_STARTED', 'No sign-in in progress. Run the auth script with --start first.');
  if (Date.now() - pending.createdAt > MAX_AGE_MS) {
    throw new PlatformError('META_AUTH_EXPIRED', 'The sign-in link is older than 1 hour. Start again.');
  }

  let url: URL;
  try {
    url = new URL(pastedUrl.trim());
  } catch {
    throw new PlatformError('META_AUTH_BAD_URL', 'Paste the full URL from the browser address bar after signing in.');
  }
  const error = url.searchParams.get('error');
  if (error) {
    throw new PlatformError(
      'META_AUTH_DENIED',
      `Sign-in was not completed: ${url.searchParams.get('error_description') ?? error}`,
    );
  }
  if (url.searchParams.get('state') !== pending.state) {
    throw new PlatformError(
      'META_AUTH_STATE',
      'The pasted URL does not belong to this sign-in (state mismatch). Start again.',
    );
  }
  // Threads and Instagram append "#_" to the redirect; URL keeps it in the hash, not the code.
  const code = url.searchParams.get('code')?.replace(/#_$/, '');
  if (!code) throw new PlatformError('META_AUTH_NO_CODE', 'The pasted URL has no "code" parameter.');
  writeSecretJson(pendingPath(platform, env), {});
  return { code, redirectUri: pending.redirectUri };
}
