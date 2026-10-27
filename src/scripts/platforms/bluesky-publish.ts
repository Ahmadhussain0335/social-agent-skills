import '../../platforms/bluesky';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Bluesky through its official API. --publish requires the user's
approval (socialkit-social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: text (300 characters), images (1-4 local, 2 MB, altText required),
link (link + options.title, options.description). Links and #hashtags become clickable.
`;

runPublishScript({ help: HELP, platform: 'bluesky' });
