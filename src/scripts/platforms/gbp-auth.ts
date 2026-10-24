import { listLocations, signInGbp } from '../../platforms/gbp';
import { printJson } from '../../shared/log';
import { runScript } from '../run';

const HELP = `
Usage:
  node scripts/auth.mjs --platform google-business [--no-browser]   sign in (local browser redirect, PKCE)
  node scripts/auth.mjs --platform google-business --locations      list locations for options.location

Signs in with your own Google Cloud Desktop OAuth client (GBP_CLIENT_SECRET_PATH, or
YT_CLIENT_SECRET_PATH) for the business.manage scope. The token is stored in the user
config directory with mode 0600. Your Cloud project must be approved for the Business
Profile APIs; see references/setup.md.
`;

runScript(
  HELP,
  { platform: { type: 'string' }, locations: { type: 'boolean' }, 'no-browser': { type: 'boolean' } },
  async (flags) => {
    if (flags.locations) {
      printJson({ locations: await listLocations() });
      return;
    }
    printJson({
      ok: true,
      tokenPath: await signInGbp(process.env, !flags['no-browser']),
      next: 'Run --locations to find options.location.',
    });
  },
);
