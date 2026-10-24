import '../../platforms/telegram';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to Telegram through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds: text (4,096), photo, video, album (2-10), captions 1,024.
Media may be local files or https URLs. options.chatId overrides TELEGRAM_CHAT_ID.
options.parseMode "HTML" enables formatting; plain text otherwise.
`;

runPublishScript({ help: HELP, platform: 'telegram' });
