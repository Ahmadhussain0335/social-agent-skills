import { existsSync, readFileSync } from 'node:fs';
import type { Check, Platform } from '../../shared/platform';
import { isTooOpen } from '../../shared/token-store';
import { tokenPath, YT_ENV } from './config';

export const youtubePlatform: Platform = {
  id: 'youtube',
  label: 'YouTube',
  skills: [
    'socialkit-youtube-pipeline',
    'socialkit-youtube-research',
    'socialkit-youtube-script',
    'socialkit-youtube-visuals',
    'socialkit-youtube-assemble',
    'socialkit-youtube-metadata',
    'socialkit-youtube-upload',
  ],
  env: [
    {
      name: YT_ENV.clientSecretPath,
      required: true,
      kind: 'path',
      description: 'OAuth "Desktop app" client JSON from your Google Cloud project',
    },
    {
      name: YT_ENV.tokenPath,
      required: false,
      kind: 'path',
      description: 'Where the OAuth token is stored (default: config dir)',
    },
    {
      name: YT_ENV.apiKey,
      required: false,
      kind: 'secret',
      description: 'API key for socialkit-youtube-research (search, statistics)',
    },
  ],
  knownLimits: [
    'videos.insert and search.list have separate 100 calls/day quota buckets; other calls share 10,000 units/day.',
    'OAuth apps in "Testing" status get refresh tokens that expire after 7 days.',
    'Custom thumbnails require a verified channel.',
  ],
  doctor(env) {
    const checks: Check[] = [];

    const secret = env[YT_ENV.clientSecretPath];
    if (!secret) {
      checks.push({
        name: YT_ENV.clientSecretPath,
        status: 'warn',
        detail: 'not set (needed for socialkit-youtube-upload only)',
      });
    } else if (!existsSync(secret)) {
      checks.push({ name: YT_ENV.clientSecretPath, status: 'fail', detail: `file not found: ${secret}` });
    } else {
      let installed = false;
      try {
        installed = Boolean((JSON.parse(readFileSync(secret, 'utf8')) as { installed?: unknown }).installed);
      } catch {
        // reported below
      }
      checks.push({
        name: YT_ENV.clientSecretPath,
        status: installed ? (isTooOpen(secret) ? 'warn' : 'ok') : 'fail',
        detail: !installed
          ? 'not a "Desktop app" OAuth client JSON'
          : isTooOpen(secret)
            ? `readable by other users; run chmod 600 "${secret}"`
            : 'found',
      });
    }

    const token = tokenPath(env);
    if (!existsSync(token)) {
      checks.push({
        name: 'YouTube OAuth token',
        status: 'warn',
        detail: `not found at ${token}; run the socialkit-youtube-upload auth script`,
      });
    } else {
      checks.push({
        name: 'YouTube OAuth token',
        status: isTooOpen(token) ? 'fail' : 'ok',
        detail: isTooOpen(token)
          ? `${token} is readable by other users; run chmod 600 "${token}"`
          : `present (${token})`,
      });
    }

    checks.push({
      name: YT_ENV.apiKey,
      status: env[YT_ENV.apiKey] ? 'ok' : 'warn',
      detail: env[YT_ENV.apiKey] ? 'set' : 'not set (needed for socialkit-youtube-research only)',
    });
    return checks;
  },
};
