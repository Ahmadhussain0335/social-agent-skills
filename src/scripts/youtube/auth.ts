import { runAuthFlow } from '../../platforms/youtube/client';
import { log, printJson } from '../../shared/log';
import { runScript } from '../run';

const HELP = `
Usage: node scripts/auth.mjs [--no-browser]

Authorises uploads to your YouTube channel with your own Google Cloud OAuth client
(type "Desktop app"). Starts a temporary listener on 127.0.0.1, opens Google sign-in,
and stores the token in your user config directory with file mode 0600.

Scope requested: https://www.googleapis.com/auth/youtube.upload (upload and thumbnails only).

Run this yourself in a terminal; it needs a browser sign-in.

Options:
  --no-browser     print the sign-in URL without opening a browser
  -h, --help       show this help

Environment:
  YT_CLIENT_SECRET_PATH   path to the OAuth client JSON (required)
  YT_TOKEN_PATH           where to store the token (default: <config dir>/youtube/token.json)
`;

runScript(HELP, { 'no-browser': { type: 'boolean' } }, async (flags) => {
  const path = await runAuthFlow({ openBrowser: !flags['no-browser'] });
  log.info('YouTube authorisation saved.');
  printJson({ ok: true, tokenPath: path });
});
