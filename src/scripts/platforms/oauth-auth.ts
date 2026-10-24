import { finishLinkedInLogin, startLinkedInLogin } from '../../platforms/linkedin';
import { finishPinterestLogin, listBoards, pinterestClient, startPinterestLogin } from '../../platforms/pinterest';
import { creatorInfo, signInTikTok, tiktokClient } from '../../platforms/tiktok';
import { signInX } from '../../platforms/x';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { loadToken } from '../../shared/oauth';
import { requireFlag, runScript } from '../run';

// One auth script for the OAuth platforms; each skill ships it with its own --platform.
const HELP = `
Usage:
  node scripts/auth.mjs --platform <x|tiktok>                        sign in through a local browser redirect
  node scripts/auth.mjs --platform <linkedin|pinterest> --start       print a sign-in URL
  node scripts/auth.mjs --platform <linkedin|pinterest> --finish --url "<URL you landed on>"
  node scripts/auth.mjs --platform <id> --status
  node scripts/auth.mjs --platform pinterest --boards                 list boards (for options.boardId)
  node scripts/auth.mjs --platform tiktok --creator-info              privacy options and limits for direct posts

Signs in with the user's own developer app. Tokens are stored in the user config
directory with mode 0600. x and tiktok listen on 127.0.0.1 for the
browser redirect; linkedin and pinterest need an HTTPS redirect page, so the user pastes
the URL they land on.
`;

runScript(
  HELP,
  {
    platform: { type: 'string' },
    start: { type: 'boolean' },
    finish: { type: 'boolean' },
    url: { type: 'string' },
    status: { type: 'boolean' },
    boards: { type: 'boolean' },
    'creator-info': { type: 'boolean' },
  },
  async (flags) => {
    const platform = requireFlag(flags, 'platform');
    const env = process.env;

    if (flags.status) {
      const store = platform === 'google-business' ? 'gbp' : platform;
      const t = platform === 'google-business' ? { accessToken: 'stored' } : loadToken(store, env);
      printJson({
        ok: true,
        platform,
        signedIn: Boolean(t.accessToken),
        ...('expiresAt' in t ? { expiresAt: t.expiresAt } : {}),
      });
      return;
    }
    if (flags.boards && platform === 'pinterest') return printJson({ boards: await listBoards(pinterestClient(env)) });
    if (flags['creator-info'] && platform === 'tiktok') return printJson(await creatorInfo(tiktokClient(env)));

    switch (platform) {
      case 'x': {
        const t = await signInX(env);
        return printJson({ ok: true, platform, expiresAt: t.expiresAt });
      }
      case 'tiktok': {
        const t = await signInTikTok(env);
        return printJson({
          ok: true,
          platform,
          expiresAt: t.expiresAt,
          next: 'Run --creator-info before a direct post.',
        });
      }
      case 'linkedin':
      case 'pinterest': {
        if (flags.start) {
          const url = platform === 'linkedin' ? startLinkedInLogin(env) : startPinterestLogin(env);
          return printJson({
            ok: true,
            signInUrl: url,
            next: 'Ask the user to open signInUrl, sign in, and paste back the URL they land on.',
          });
        }
        if (flags.finish) {
          const url = requireFlag(flags, 'url');
          const t =
            platform === 'linkedin' ? await finishLinkedInLogin(url, env) : await finishPinterestLogin(url, env);
          return printJson({
            ok: true,
            platform,
            expiresAt: t.expiresAt,
            ...(t.extra?.name ? { member: t.extra.name } : {}),
          });
        }
        throw new PlatformError('AUTH_ACTION', `Use --start or --finish for ${platform}.`);
      }
      default:
        throw new PlatformError('AUTH_PLATFORM', `Unknown platform "${platform}".`);
    }
  },
);
