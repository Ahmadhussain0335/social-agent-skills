import { finishFacebookLogin, loadFacebookTokens, startFacebookLogin } from '../../platforms/meta/accounts';
import {
  finishThreadsLogin,
  loadThreadsTokens,
  refreshThreadsToken,
  startThreadsLogin,
} from '../../platforms/threads/auth';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage:
  node scripts/auth.mjs --platform <facebook|threads> --start [--with-engagement]
  node scripts/auth.mjs --platform <facebook|threads> --finish --url "<redirected URL>"
  node scripts/auth.mjs --platform <facebook|threads> --status
  node scripts/auth.mjs --platform threads --refresh

Signs in to Meta with the user's own app. "facebook" covers Facebook Pages and the
Instagram professional accounts linked to them; "threads" uses the separate Threads app ID.

--start prints a sign-in URL. The user opens it, signs in, and is sent to the redirect URI.
They copy the full URL from the address bar; --finish --url "<that URL>" completes sign-in.
Tokens are stored in the user config directory with mode 0600. Facebook Page tokens do not
expire; Threads tokens last 60 days and are refreshed automatically when publishing.

--with-engagement also requests reading comments and replying, and insights (needed by
social-inbox and social-analytics). Without it only posting permissions are requested.

Environment:
  facebook: META_APP_ID, META_APP_SECRET, META_REDIRECT_URI, optional META_LOGIN_CONFIG_ID
  threads:  THREADS_APP_ID, THREADS_APP_SECRET, THREADS_REDIRECT_URI
`;

runScript(
  HELP,
  {
    platform: { type: 'string' },
    start: { type: 'boolean' },
    finish: { type: 'boolean' },
    url: { type: 'string' },
    status: { type: 'boolean' },
    refresh: { type: 'boolean' },
    'with-engagement': { type: 'boolean' },
  },
  async (flags) => {
    const platform = requireFlag(flags, 'platform');
    if (platform !== 'facebook' && platform !== 'threads') {
      throw new PlatformError('META_PLATFORM', '--platform must be facebook or threads (Instagram uses facebook).');
    }

    if (flags.start) {
      const engagement = Boolean(flags['with-engagement']);
      const url =
        platform === 'facebook'
          ? startFacebookLogin(process.env, engagement)
          : startThreadsLogin(process.env, engagement);
      printJson({
        ok: true,
        signInUrl: url,
        next: 'Ask the user to open signInUrl, sign in, and paste back the URL they land on.',
      });
      return;
    }
    if (flags.finish) {
      const pasted = requireFlag(flags, 'url');
      if (platform === 'facebook') {
        const tokens = await finishFacebookLogin(pasted);
        printJson({ ok: true, pages: summarisePages(tokens.pages) });
      } else {
        const tokens = await finishThreadsLogin(pasted);
        printJson({ ok: true, threadsUserId: tokens.userId, expiresAt: tokens.expiresAt });
      }
      return;
    }
    if (flags.refresh && platform === 'threads') {
      const tokens = await refreshThreadsToken();
      printJson({ ok: true, expiresAt: tokens.expiresAt });
      return;
    }
    if (platform === 'facebook') {
      printJson({ ok: true, pages: summarisePages(loadFacebookTokens().pages) });
    } else {
      const t = loadThreadsTokens();
      printJson({ ok: true, threadsUserId: t.userId, expiresAt: t.expiresAt });
    }
  },
);

function summarisePages(pages: ReturnType<typeof loadFacebookTokens>['pages']) {
  return pages.map((p) => ({
    id: p.id,
    name: p.name,
    canPost: p.tasks.includes('CREATE_CONTENT'),
    instagram: p.instagram ? { id: p.instagram.id, username: p.instagram.username } : null,
  }));
}
