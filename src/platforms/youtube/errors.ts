import { PlatformError } from '../../shared/errors';
import { YT_DOCS } from './config';

interface GoogleApiErrorShape {
  code?: number | string;
  status?: number;
  message?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  response?: { status?: number; data?: { error?: string | { message?: string; errors?: Array<{ reason?: string }> } } };
}

/** Extracts the API "reason" (e.g. quotaExceeded) or OAuth error code (e.g. invalid_grant). */
export function errorReason(error: unknown): string | undefined {
  const e = error as GoogleApiErrorShape;
  const data = e?.response?.data?.error;
  if (typeof data === 'string') return data;
  return data?.errors?.[0]?.reason ?? e?.errors?.[0]?.reason;
}

/** Maps Google API failures to messages that tell the user what to do next. */
export function toYouTubeError(error: unknown): PlatformError {
  if (error instanceof PlatformError) return error;
  const reason = errorReason(error);
  const raw = (error as Error)?.message ?? String(error);

  switch (reason) {
    case 'quotaExceeded':
      return new PlatformError(
        'YT_QUOTA_EXCEEDED',
        'YouTube API quota exceeded for today.',
        'Quotas reset at midnight Pacific Time. videos.insert and search.list have separate 100 calls/day buckets; other calls share 10,000 units. Request more through the quota extension form, which starts a compliance audit of your API project.',
        YT_DOCS.quotaExtension,
      );
    case 'uploadLimitExceeded':
      return new PlatformError(
        'YT_UPLOAD_LIMIT',
        'This channel has reached its YouTube upload limit.',
        'The limit is per channel and set by YouTube, not by API quota. Try again later or upload in YouTube Studio.',
      );
    case 'rateLimitExceeded':
    case 'userRateLimitExceeded':
      return new PlatformError('YT_RATE_LIMITED', 'Too many requests in a short time.', 'Wait a minute and retry.');
    case 'invalid_grant':
      return new PlatformError(
        'YT_TOKEN_EXPIRED',
        'The stored YouTube refresh token is expired or revoked.',
        'Run the auth script again. Apps whose OAuth consent screen is in "Testing" status get refresh tokens that expire after 7 days; set the app to "In production" (and complete Google OAuth verification if the console asks for it) to avoid this.',
        YT_DOCS.consentScreen,
      );
    case 'insufficientPermissions':
    case 'forbidden':
      return new PlatformError(
        'YT_FORBIDDEN',
        `YouTube refused the request (${reason}).`,
        'Re-run the auth script and grant the youtube.upload scope with the Google account that owns the target channel.',
      );
    case 'youtubeSignupRequired':
      return new PlatformError(
        'YT_NO_CHANNEL',
        'The authorised Google account has no YouTube channel.',
        'Create a channel at youtube.com, then re-run the auth script.',
      );
    case 'accessNotConfigured':
      return new PlatformError(
        'YT_API_DISABLED',
        'YouTube Data API v3 is not enabled for your Google Cloud project.',
        'Enable "YouTube Data API v3" in the Google Cloud console for the project that owns your OAuth client.',
      );
    case 'invalidPublishAt':
      return new PlatformError(
        'YT_INVALID_SCHEDULE',
        'YouTube rejected the scheduled publish time.',
        'The time must be in the future, in ISO 8601 format, and the video must be private until then.',
      );
    case 'forbiddenPrivacySetting':
      return new PlatformError(
        'YT_PRIVACY_FORBIDDEN',
        'YouTube does not allow the requested privacy setting for this video.',
      );
    case 'invalidTitle':
    case 'invalidDescription':
    case 'invalidTags':
    case 'invalidCategoryId':
      return new PlatformError(
        'YT_INVALID_METADATA',
        `YouTube rejected the metadata (${reason}).`,
        'Run the metadata check script and fix the reported fields.',
      );
    default:
      return new PlatformError('YT_API_ERROR', reason ? `${reason}: ${raw}` : raw);
  }
}
