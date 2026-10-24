import '../../platforms/discord';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Discord through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: text (2,000 characters), media (up to 10 local attachments).
options.webhookEnv names another env var holding a different channel's webhook URL.
Mentions never ping unless options.allowMentions is true.
`;

runPublishScript({ help: HELP, platform: 'discord' });
