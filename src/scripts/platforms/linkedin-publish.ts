import '../../platforms/linkedin';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to LinkedIn (personal profile) through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: text, link (options.title, options.description), image (local JPG/PNG/GIF),
video (local MP4). Up to 3,000 characters. No API scheduling.
Company pages need the Community Management API and options.organizationUrn.
`;

runPublishScript({ help: HELP, platform: 'linkedin' });
