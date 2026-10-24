import '../../platforms/meta/post-platforms';
import { runPublishScript } from '../publish-runner';

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

runPublishScript({ help: HELP, platform: 'threads' });
