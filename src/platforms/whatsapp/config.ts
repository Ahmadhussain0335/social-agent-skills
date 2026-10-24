import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { GRAPH_FACEBOOK, graphVersion } from '../meta/config';
import { GraphClient, type GraphErrorBody } from '../meta/graph';

export const WA_ENV = {
  accessToken: 'WA_ACCESS_TOKEN',
  phoneNumberId: 'WA_PHONE_NUMBER_ID',
  wabaId: 'WA_WABA_ID',
  appSecret: 'WA_APP_SECRET',
  verifyToken: 'WA_VERIFY_TOKEN',
  ratesPath: 'WA_RATES_PATH',
} as const;

export function requireEnv(name: string, env: NodeJS.ProcessEnv, hint: string): string {
  const value = env[name];
  if (!value) throw new PlatformError('WA_ENV_MISSING', `${name} is not set.`, hint);
  return value;
}

const SETUP_HINT = 'See the whatsapp skill references/setup.md for creating a System User token and finding your IDs.';

export function waClient(env: NodeJS.ProcessEnv = process.env): GraphClient {
  return new GraphClient({
    baseUrl: GRAPH_FACEBOOK,
    version: graphVersion(env),
    accessToken: requireEnv(WA_ENV.accessToken, env, SETUP_HINT),
    appSecret: env[WA_ENV.appSecret],
    hintFor: whatsappHint,
  });
}

export function phoneNumberId(env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv(WA_ENV.phoneNumberId, env, SETUP_HINT);
}

export function wabaId(env: NodeJS.ProcessEnv = process.env): string {
  return requireEnv(WA_ENV.wabaId, env, SETUP_HINT);
}

export function ratesPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[WA_ENV.ratesPath] || join(platformDir('whatsapp', env), 'rates.json');
}

// https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
const HINTS: Record<number, string> = {
  130429: 'Throughput limit reached; the sender slows down and retries.',
  131026:
    'Message undeliverable: the number is not on WhatsApp, has not accepted the latest terms, or uses an old app.',
  131031: 'The WhatsApp Business Account is restricted. Check Business Manager before sending more.',
  131042: 'Billing problem on the WhatsApp Business Account. Add or fix the payment method in Business Settings.',
  131047: 'Outside the 24-hour customer service window: only approved templates can be sent now.',
  131048: 'Sending restricted because too many messages were reported as spam. Stop and review message quality.',
  131049: 'Meta limited marketing messages to this user. Do not resend for at least 24 hours.',
  131050: 'The user opted out of marketing messages. Do not message them again with marketing.',
  131056: 'Too many messages to the same user in a short time. Slow down.',
  132000: 'The number of template parameters does not match the template.',
  132001: 'Template does not exist in this language or is not approved yet.',
  132007: 'Template content violates WhatsApp policy.',
  132015: 'Template is paused because of low quality. Fix it before sending again.',
  132016: 'Template is disabled because of low quality.',
  133010: 'Phone number is not registered with the Cloud API.',
};

export function whatsappHint(error: GraphErrorBody): string | undefined {
  return error.code !== undefined ? HINTS[error.code] : undefined;
}
