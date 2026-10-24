import { loadFacebookTokens, META_ENV, selectPage } from '../../platforms/meta/accounts';
import { GRAPH_FACEBOOK, graphVersion } from '../../platforms/meta/config';
import { checkFacebookPost, publishFacebook } from '../../platforms/meta/facebook';
import { GraphClient } from '../../platforms/meta/graph';
import { runPublishScript } from './publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to a Facebook Page through the official Graph API. Pages only:
the API cannot post to personal profiles. --publish requires the user's approval
(social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  text     message only                       link    message + "link"
  photo    one image (local file or https)     photos  2+ images in one post
  video    one video (local file or https), optional options.title

scheduledAt: 10 minutes to 30 days ahead (videos up to 6 months).
options.pageId: required when the sign-in covers several Pages.

Environment: META_APP_SECRET (adds appsecret_proof). Sign in with the meta-auth skill first.
`;

runPublishScript({
  help: HELP,
  check: (draft) => checkFacebookPost(draft),
  publish: async (dir, draft) => {
    const page = selectPage(loadFacebookTokens(), draft.options?.pageId as string | undefined);
    const client = new GraphClient({
      baseUrl: GRAPH_FACEBOOK,
      version: graphVersion(),
      accessToken: page.accessToken,
      appSecret: process.env[META_ENV.appSecret],
    });
    const result = await publishFacebook(client, page.id, dir, draft);
    return { ...result, page: page.name };
  },
});
