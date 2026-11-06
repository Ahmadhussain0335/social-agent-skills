import { PlatformError } from '../../shared/errors';
import { googleAccessToken, readDesktopClient, signInGoogle } from '../google/oauth';
import { tokenPath, YT_ENV, YT_SCOPES } from './config';
import { type YouTubeApi, youtubeRest } from './rest';

/** Authorised client for upload calls. Refreshed tokens are written back with mode 0600. */
export function authorisedClient(env: NodeJS.ProcessEnv = process.env): YouTubeApi {
  const client = readDesktopClient(env[YT_ENV.clientSecretPath], YT_ENV.clientSecretPath);
  return youtubeRest({
    bearer: () =>
      googleAccessToken({
        client,
        tokenFile: tokenPath(env),
        notSignedInHint:
          'Ask the user to run the socialkit-youtube-upload auth script in their own terminal: node scripts/auth.mjs',
      }),
  });
}

export function apiKeyClient(env: NodeJS.ProcessEnv = process.env): YouTubeApi {
  const key = env[YT_ENV.apiKey];
  if (!key) {
    throw new PlatformError(
      'YT_API_KEY_MISSING',
      `${YT_ENV.apiKey} is not set.`,
      'Create an API key restricted to "YouTube Data API v3" in your Google Cloud project and export it as YT_API_KEY. See references/setup.md.',
    );
  }
  return youtubeRest({ apiKey: key });
}

export interface AuthFlowOptions {
  env?: NodeJS.ProcessEnv;
  openBrowser?: boolean;
}

/** Installed-app OAuth with a loopback redirect, PKCE and a state check. */
export function runAuthFlow(opts: AuthFlowOptions = {}): Promise<string> {
  const env = opts.env ?? process.env;
  return signInGoogle({
    client: readDesktopClient(env[YT_ENV.clientSecretPath], YT_ENV.clientSecretPath),
    scopes: YT_SCOPES,
    tokenFile: tokenPath(env),
    openBrowser: opts.openBrowser,
  });
}
