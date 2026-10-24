import '../../platforms/mastodon';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Mastodon through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: text, media (local files with altText), poll (options.poll).
options.visibility: public | unlisted | private | direct. scheduledAt at least 5 minutes ahead.
The character limit is read from your instance.
`;

runPublishScript({ help: HELP, platform: 'mastodon' });
