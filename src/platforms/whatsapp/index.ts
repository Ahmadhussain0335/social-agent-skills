import type { Check, Platform } from '../../shared/platform';
import { WA_ENV } from './config';

export const whatsappPlatform: Platform = {
  id: 'whatsapp',
  label: 'WhatsApp Business Platform (Cloud API)',
  skills: ['socialkit-whatsapp-templates', 'socialkit-whatsapp-broadcast', 'socialkit-whatsapp-support-bot'],
  env: [
    { name: WA_ENV.accessToken, required: true, kind: 'secret', description: 'System User access token' },
    { name: WA_ENV.phoneNumberId, required: true, kind: 'value', description: 'Business phone number ID' },
    { name: WA_ENV.wabaId, required: true, kind: 'value', description: 'WhatsApp Business Account ID' },
    {
      name: WA_ENV.appSecret,
      required: false,
      kind: 'secret',
      description: 'App secret (support bot webhook signatures)',
    },
    { name: WA_ENV.verifyToken, required: false, kind: 'secret', description: 'Webhook verify token (support bot)' },
  ],
  knownLimits: [
    'Templates only outside the 24-hour customer service window.',
    'Messages only to contacts with a recorded opt-in.',
    'General-purpose AI assistants are prohibited (Meta terms section 4.7, from 2026-01-15).',
    'Service messages are charged after 1,000 free per month per number (from 2026-10-01).',
  ],
  doctor(env) {
    const required = [WA_ENV.accessToken, WA_ENV.phoneNumberId, WA_ENV.wabaId];
    const missing = required.filter((name) => !env[name]);
    const checks: Check[] = [
      {
        name: 'WhatsApp',
        status: missing.length === 0 ? 'ok' : 'warn',
        detail:
          missing.length === 0
            ? 'credentials set'
            : `not configured (${missing.join(', ')} unset); only needed for socialkit-whatsapp-* skills`,
      },
    ];
    if (missing.length === 0 && (!env[WA_ENV.appSecret] || !env[WA_ENV.verifyToken])) {
      checks.push({
        name: 'WhatsApp bot',
        status: 'warn',
        detail: 'WA_APP_SECRET and WA_VERIFY_TOKEN are needed for the support bot webhook',
      });
    }
    return checks;
  },
};
