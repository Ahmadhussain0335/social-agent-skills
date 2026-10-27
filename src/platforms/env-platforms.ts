import { existsSync } from 'node:fs';
import { tokenPath } from '../shared/oauth';
import type { Check, Platform } from '../shared/platform';
import { isTooOpen } from '../shared/token-store';

// Doctor entries for platforms configured purely through environment variables, with an
// optional OAuth token file. Unconfigured platforms are warnings, never failures.

function envPlatform(opts: {
  id: string;
  label: string;
  skill: string;
  required: string[];
  token?: string;
  limits: string[];
}): Platform {
  return {
    id: opts.id,
    label: opts.label,
    skills: [opts.skill],
    env: opts.required.map((name) => ({
      name,
      required: true,
      kind: /PATH$/.test(name) ? 'path' : /TOKEN|SECRET|PASSWORD|WEBHOOK/.test(name) ? 'secret' : 'value',
      description: `${opts.label} setting`,
    })),
    knownLimits: opts.limits,
    doctor(env): Check[] {
      const missing = opts.required.filter((n) => !env[n]);
      if (missing.length > 0) {
        return [
          {
            name: opts.label,
            status: 'warn',
            detail: `not configured (${missing.join(', ')} unset); only needed for ${opts.skill}`,
          },
        ];
      }
      if (!opts.token) return [{ name: opts.label, status: 'ok', detail: 'configured' }];
      const path = tokenPath(opts.token, env);
      if (!existsSync(path))
        return [
          {
            name: opts.label,
            status: 'warn',
            detail: `configured but not signed in; run ${opts.skill} scripts/auth.mjs`,
          },
        ];
      if (isTooOpen(path))
        return [
          { name: opts.label, status: 'fail', detail: `${path} is readable by other users; run chmod 600 "${path}"` },
        ];
      return [{ name: opts.label, status: 'ok', detail: 'signed in' }];
    },
  };
}

export const ENV_PLATFORMS: readonly Platform[] = [
  envPlatform({
    id: 'x',
    label: 'X',
    skill: 'socialkit-x-post',
    required: ['X_CLIENT_ID'],
    token: 'x',
    limits: ['Pay-per-use: about $0.015 per post, $0.20 with a link.'],
  }),
  envPlatform({
    id: 'linkedin',
    label: 'LinkedIn',
    skill: 'socialkit-linkedin-post',
    required: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET', 'LINKEDIN_REDIRECT_URI'],
    token: 'linkedin',
    limits: ['Personal profile only; tokens last 60 days.'],
  }),
  envPlatform({
    id: 'pinterest',
    label: 'Pinterest',
    skill: 'socialkit-pinterest-post',
    required: ['PINTEREST_APP_ID', 'PINTEREST_APP_SECRET', 'PINTEREST_REDIRECT_URI'],
    token: 'pinterest',
    limits: ['Trial access: Pins visible only to you.'],
  }),
  envPlatform({
    id: 'tiktok',
    label: 'TikTok',
    skill: 'socialkit-tiktok-post',
    required: ['TIKTOK_CLIENT_KEY', 'TIKTOK_CLIENT_SECRET'],
    token: 'tiktok',
    limits: ['Unaudited apps: drafts or private posts only.'],
  }),
  envPlatform({
    id: 'telegram',
    label: 'Telegram',
    skill: 'socialkit-telegram-post',
    required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'],
    limits: ['Bot must be a channel admin.'],
  }),
  envPlatform({
    id: 'discord',
    label: 'Discord',
    skill: 'socialkit-discord-post',
    required: ['DISCORD_WEBHOOK_URL'],
    limits: ['Webhook URL is a secret.'],
  }),
  envPlatform({
    id: 'bluesky',
    label: 'Bluesky',
    skill: 'socialkit-bluesky-post',
    required: ['BLUESKY_HANDLE', 'BLUESKY_APP_PASSWORD'],
    limits: ['App password, never the account password.'],
  }),
  envPlatform({
    id: 'mastodon',
    label: 'Mastodon',
    skill: 'socialkit-mastodon-post',
    required: ['MASTODON_INSTANCE', 'MASTODON_ACCESS_TOKEN'],
    limits: ['Limits vary per instance.'],
  }),
  envPlatform({
    id: 'google-business',
    label: 'Google Business Profile',
    skill: 'socialkit-google-business-post',
    required: [],
    token: 'gbp',
    limits: ['Cloud project must be approved for the APIs.'],
  }),
];
