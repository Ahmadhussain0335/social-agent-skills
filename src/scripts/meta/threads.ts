import { GraphClient } from '../../platforms/meta/graph';
import {
  loadThreadsTokens,
  needsRefresh,
  refreshThreadsToken,
  THREADS_ENV,
  THREADS_GRAPH,
  THREADS_VERSION,
} from '../../platforms/threads/auth';
import { checkThreadsPost, publishThreads, threadsQuota } from '../../platforms/threads/publish';
import { PlatformError } from '../../shared/errors';
import { runPublishScript } from './publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Threads through the official Threads API. --publish requires the
user's approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  text      up to 500 characters, optional "link" attachment
  image     one image at a public https URL
  video     one video at a public https URL
  carousel  2-20 images/videos at public https URLs

At most 5 links per post. options.topicTag: one tag, 1-50 characters, no "." or "&".
No scheduling via the API. The token is refreshed automatically when close to expiry.
`;

runPublishScript({
  help: HELP,
  check: (draft) => checkThreadsPost(draft),
  publish: async (_dir, draft) => {
    let tokens = loadThreadsTokens();
    if (needsRefresh(tokens)) tokens = await refreshThreadsToken();
    const client = new GraphClient({
      baseUrl: THREADS_GRAPH,
      version: THREADS_VERSION,
      accessToken: tokens.accessToken,
      appSecret: process.env[THREADS_ENV.appSecret],
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
