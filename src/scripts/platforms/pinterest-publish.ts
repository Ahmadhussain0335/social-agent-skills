import '../../platforms/pinterest';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Pinterest through its official API. --publish requires the user's
approval (socialkit-social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: image (local file or https), carousel (2-5 images), video (local + options.coverImageUrl).
Required: options.boardId. Optional: options.title (100), text = description (800), link, altText (500).
`;

runPublishScript({ help: HELP, platform: 'pinterest' });
