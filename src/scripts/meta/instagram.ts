import { loadFacebookTokens, META_ENV, selectInstagram } from '../../platforms/meta/accounts';
import { GRAPH_FACEBOOK, graphVersion } from '../../platforms/meta/config';
import { GraphClient, type GraphErrorBody } from '../../platforms/meta/graph';
import { checkInstagramPost, instagramHint, publishInstagram, publishingLimit } from '../../platforms/meta/instagram';
import { PlatformError } from '../../shared/errors';
import { runPublishScript } from './publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to an Instagram Business or Creator account linked to a Facebook
Page, through the official Instagram Graph API. --publish requires the user's approval
(social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  image     one JPEG at a public https URL
  carousel  2-10 items (images by https URL; videos by https URL)
  reel      one MP4/MOV video, local file (uploaded directly) or https URL
  story     one image (https URL) or video (local or https)

Caption: 2,200 characters, 30 hashtags, 20 @mentions. No scheduling via the API.
options.instagramAccountId: required when several Instagram accounts are linked.
`;

runPublishScript({
  help: HELP,
  check: (draft) => checkInstagramPost(draft),
  publish: async (dir, draft) => {
    const { page, igUserId } = selectInstagram(
      loadFacebookTokens(),
      draft.options?.instagramAccountId as string | undefined,
    );
    const version = graphVersion();
    const client = new GraphClient({
      baseUrl: GRAPH_FACEBOOK,
      version,
      accessToken: page.accessToken,
      appSecret: process.env[META_ENV.appSecret],
      hintFor: (error: GraphErrorBody) => instagramHint(error.error_subcode),
    });
    const limit = await publishingLimit(client, igUserId);
    if (limit.total !== undefined && limit.used >= limit.total) {
      throw new PlatformError(
        'IG_DAILY_LIMIT',
        `Instagram publishing limit reached (${limit.used}/${limit.total} in 24 hours).`,
      );
    }
    const result = await publishInstagram(
      { client, igUserId, accessToken: page.accessToken, graphVersion: version, dir },
      draft,
    );
    return { ...result, instagramAccount: page.instagram?.username ?? igUserId, quota: limit };
  },
});
