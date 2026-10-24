import { join } from 'node:path';
import { platformDir } from '../../shared/config-paths';
import { PlatformError } from '../../shared/errors';
import { QuotaLedger } from '../../shared/quota';

export const YT_ENV = {
  clientSecretPath: 'YT_CLIENT_SECRET_PATH',
  tokenPath: 'YT_TOKEN_PATH',
  apiKey: 'YT_API_KEY',
} as const;

// Upload and thumbnail only. No read or manage scopes: research uses an API key instead.
export const YT_SCOPES = ['https://www.googleapis.com/auth/youtube.upload'] as const;

export const YT_DOCS = {
  setup: 'https://developers.google.com/youtube/v3/guides/uploading_a_video',
  quota: 'https://developers.google.com/youtube/v3/determine_quota_cost',
  quotaExtension: 'https://support.google.com/youtube/contact/yt_api_form',
  consentScreen: 'https://console.cloud.google.com/auth/overview',
  syntheticMedia: 'https://support.google.com/youtube/answer/14328491',
  inauthenticContent: 'https://support.google.com/youtube/answer/1311392',
} as const;

// Quota buckets as documented on 2026-10-15 (determine_quota_cost): videos.insert and
// search.list each have their own 100 calls/day bucket; everything else shares 10,000 units.
// All reset at midnight Pacific Time.
export const YT_QUOTA = {
  resetTimeZone: 'America/Los_Angeles',
  buckets: {
    uploads: { dailyLimit: 100 },
    search: { dailyLimit: 100 },
    units: { dailyLimit: 10_000 },
  },
  cost: {
    'videos.insert': { bucket: 'uploads', units: 1 },
    'search.list': { bucket: 'search', units: 1 },
    'videos.list': { bucket: 'units', units: 1 },
    'thumbnails.set': { bucket: 'units', units: 50 },
  },
} as const;

export type YtMethod = keyof typeof YT_QUOTA.cost;

export function tokenPath(env: NodeJS.ProcessEnv = process.env): string {
  return env[YT_ENV.tokenPath] || join(platformDir('youtube', env), 'token.json');
}

export function clientSecretPath(env: NodeJS.ProcessEnv = process.env): string {
  const path = env[YT_ENV.clientSecretPath];
  if (!path) {
    throw new PlatformError(
      'YT_CLIENT_SECRET_MISSING',
      `${YT_ENV.clientSecretPath} is not set.`,
      'Create an OAuth client of type "Desktop app" in your own Google Cloud project, download its JSON, store it outside any repository and set YT_CLIENT_SECRET_PATH to that file. See references/setup.md.',
    );
  }
  return path;
}

export function quotaLedger(method: YtMethod, env: NodeJS.ProcessEnv = process.env): QuotaLedger {
  const { bucket } = YT_QUOTA.cost[method];
  return new QuotaLedger({
    path: join(platformDir('youtube', env), `quota-${bucket}.json`),
    dailyLimit: YT_QUOTA.buckets[bucket].dailyLimit,
    resetTimeZone: YT_QUOTA.resetTimeZone,
  });
}

/** Records the call locally and refuses to start when the local estimate says the bucket is spent. */
export function spendQuota(method: YtMethod, env: NodeJS.ProcessEnv = process.env): void {
  const ledger = quotaLedger(method, env);
  const { units, bucket } = YT_QUOTA.cost[method];
  if (!ledger.canSpend(units)) {
    throw new PlatformError(
      'YT_QUOTA_ESTIMATE_EXHAUSTED',
      `Local estimate says the YouTube "${bucket}" quota bucket is used up for today (${ledger.today()} Pacific Time).`,
      'Quotas reset at midnight Pacific Time. Check real usage in the Google Cloud console; if the estimate is wrong, delete the quota file in your social-skills config directory.',
      YT_DOCS.quota,
    );
  }
  ledger.record(units);
}
