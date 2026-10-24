import '../../platforms/gbp';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Google Business Profile through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: standard, event, offer. Required: options.location ("accounts/../locations/..").
Optional: options.cta { actionType, url }, options.event { title, schedule }, options.offer,
media as https photo URLs.
`;

runPublishScript({ help: HELP, platform: 'google-business' });
