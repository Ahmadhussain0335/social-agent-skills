import '../../platforms/meta/post-platforms';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to a Facebook Page through the official Graph API. Pages only:
the API cannot post to personal profiles. --publish requires the user's approval
(socialkit-social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  text     message only                       link    message + "link"
  photo    one image (local file or https)     photos  2+ images in one post
  video    one video (local file or https), optional options.title

scheduledAt: 10 minutes to 30 days ahead (videos up to 6 months).
options.pageId: required when the sign-in covers several Pages.

Environment: META_APP_SECRET (adds appsecret_proof). Sign in with the socialkit-meta-auth skill first.
`;

runPublishScript({ help: HELP, platform: 'facebook' });
