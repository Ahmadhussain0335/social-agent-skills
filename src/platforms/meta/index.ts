import { existsSync } from 'node:fs';
import type { Check, Platform } from '../../shared/platform';
import { isTooOpen } from '../../shared/token-store';
import { THREADS_ENV, threadsTokenPath } from '../threads/auth';
import { facebookTokenPath, META_ENV } from './accounts';

function tokenCheck(name: string, path: string, configured: boolean): Check {
  if (!configured) return { name, status: 'warn', detail: 'not configured; only needed for its posting skills' };
  if (!existsSync(path))
    return { name, status: 'warn', detail: 'app configured but not signed in; run the socialkit-meta-auth skill' };
  if (isTooOpen(path))
    return { name, status: 'fail', detail: `${path} is readable by other users; run chmod 600 "${path}"` };
  return { name, status: 'ok', detail: `signed in (${path})` };
}

export const metaPlatform: Platform = {
  id: 'meta',
  label: 'Meta (Facebook Pages, Instagram, Threads)',
  skills: ['socialkit-meta-auth', 'socialkit-facebook-post', 'socialkit-instagram-post', 'socialkit-threads-post'],
  env: [
    { name: META_ENV.appId, required: true, kind: 'value', description: 'Facebook/Instagram app ID' },
    { name: META_ENV.appSecret, required: true, kind: 'secret', description: 'Facebook/Instagram app secret' },
    {
      name: META_ENV.redirectUri,
      required: true,
      kind: 'value',
      description: 'HTTPS redirect URL registered in the app',
    },
    { name: THREADS_ENV.appId, required: false, kind: 'value', description: 'Threads app ID' },
    { name: THREADS_ENV.appSecret, required: false, kind: 'secret', description: 'Threads app secret' },
    { name: THREADS_ENV.redirectUri, required: false, kind: 'value', description: 'Threads HTTPS redirect URL' },
  ],
  knownLimits: [
    'Facebook: Pages only, no personal profiles.',
    'Instagram: Business or Creator account linked to a Facebook Page; images from a public URL.',
    'Threads: media from a public URL; no API scheduling.',
  ],
  doctor(env) {
    const fb = Boolean(env[META_ENV.appId] && env[META_ENV.appSecret] && env[META_ENV.redirectUri]);
    const th = Boolean(env[THREADS_ENV.appId] && env[THREADS_ENV.appSecret] && env[THREADS_ENV.redirectUri]);
    return [
      tokenCheck('Facebook/Instagram', facebookTokenPath(env), fb),
      tokenCheck('Threads', threadsTokenPath(env), th),
    ];
  },
};
