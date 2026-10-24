import { PlatformError } from '../../shared/errors';
import { registerPostPlatform } from '../posting';
import {
  loadThreadsTokens,
  needsRefresh,
  refreshThreadsToken,
  THREADS_ENV,
  THREADS_GRAPH,
  THREADS_VERSION,
} from '../threads/auth';
import { checkThreadsPost, publishThreads, THREADS_KINDS, THREADS_LIMITS, threadsQuota } from '../threads/publish';
import { loadFacebookTokens, META_ENV, selectInstagram, selectPage } from './accounts';
import { GRAPH_FACEBOOK, graphVersion } from './config';
import {
  facebookComments,
  facebookMetrics,
  facebookReply,
  instagramComments,
  instagramMetrics,
  instagramReply,
  threadsComments,
  threadsMetrics,
  threadsReply,
} from './engagement';
import { checkFacebookPost, FB_KINDS, publishFacebook } from './facebook';
import { GraphClient, type GraphErrorBody } from './graph';
import { checkInstagramPost, IG_KINDS, IG_LIMITS, instagramHint, publishInstagram, publishingLimit } from './instagram';

registerPostPlatform({
  id: 'facebook',
  label: 'Facebook Page',
  kinds: FB_KINDS,
  textLimit: 63206,
  scheduling: true,
  notes: [
    'Pages only, never personal profiles.',
    'Local photos and videos upload directly.',
    'Schedule 10 minutes to 30 days ahead.',
  ],
  check: (draft, now) => checkFacebookPost(draft, now),
  metrics: facebookMetrics,
  comments: facebookComments,
  reply: facebookReply,
  async publish(dir, draft, env) {
    const page = selectPage(loadFacebookTokens(env), draft.options?.pageId as string | undefined);
    const client = new GraphClient({
      baseUrl: GRAPH_FACEBOOK,
      version: graphVersion(env),
      accessToken: page.accessToken,
      appSecret: env[META_ENV.appSecret],
    });
    return { ...(await publishFacebook(client, page.id, dir, draft)), page: page.name };
  },
});

registerPostPlatform({
  id: 'instagram',
  label: 'Instagram',
  kinds: IG_KINDS,
  textLimit: IG_LIMITS.captionChars,
  scheduling: false,
  notes: [
    'Business or Creator account linked to a Facebook Page.',
    'Images: JPEG at a public https URL. Reels can be local MP4/MOV.',
    `Up to ${IG_LIMITS.hashtags} hashtags and ${IG_LIMITS.mentions} mentions; links in captions are not clickable.`,
  ],
  check: (draft) => checkInstagramPost(draft),
  metrics: instagramMetrics,
  comments: instagramComments,
  reply: instagramReply,
  async publish(dir, draft, env) {
    const { page, igUserId } = selectInstagram(
      loadFacebookTokens(env),
      draft.options?.instagramAccountId as string | undefined,
    );
    const version = graphVersion(env);
    const client = new GraphClient({
      baseUrl: GRAPH_FACEBOOK,
      version,
      accessToken: page.accessToken,
      appSecret: env[META_ENV.appSecret],
      hintFor: (error: GraphErrorBody) => instagramHint(error.error_subcode),
    });
    const quota = await publishingLimit(client, igUserId);
    if (quota.total !== undefined && quota.used >= quota.total) {
      throw new PlatformError(
        'IG_DAILY_LIMIT',
        `Instagram publishing limit reached (${quota.used}/${quota.total} in 24 hours).`,
      );
    }
    const result = await publishInstagram(
      { client, igUserId, accessToken: page.accessToken, graphVersion: version, dir },
      draft,
    );
    return { ...result, instagramAccount: page.instagram?.username ?? igUserId, quota };
  },
});

registerPostPlatform({
  id: 'threads',
  label: 'Threads',
  kinds: THREADS_KINDS,
  textLimit: THREADS_LIMITS.textChars,
  scheduling: false,
  notes: ['Emoji count as several characters.', 'At most 5 links.', 'Media must be at public https URLs.'],
  check: (draft) => checkThreadsPost(draft),
  metrics: threadsMetrics,
  comments: threadsComments,
  reply: (comment, text, env) => threadsReply(comment, text, env),
  async publish(_dir, draft, env) {
    let tokens = loadThreadsTokens(env);
    if (needsRefresh(tokens)) tokens = await refreshThreadsToken(env);
    const client = new GraphClient({
      baseUrl: THREADS_GRAPH,
      version: THREADS_VERSION,
      accessToken: tokens.accessToken,
      appSecret: env[THREADS_ENV.appSecret],
    });
    const quota = await threadsQuota(client, tokens.userId);
    if (quota.total !== undefined && quota.used >= quota.total) {
      throw new PlatformError(
        'THREADS_DAILY_LIMIT',
        `Threads publishing limit reached (${quota.used}/${quota.total} in 24 hours).`,
      );
    }
    return { ...(await publishThreads(client, tokens.userId, draft)), quota };
  },
});
