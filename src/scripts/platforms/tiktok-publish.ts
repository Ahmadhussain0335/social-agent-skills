import '../../platforms/tiktok';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to TikTok through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kind: video (one local MP4/MOV/WebM).
options.mode "draft" (default): sent to your TikTok inbox, you post it in the app.
options.mode "direct": needs options.privacyLevel, options.creatorNickname (from auth.mjs --creator-info)
and explicit options.allowComment / allowDuet / allowStitch. Unaudited apps post privately (SELF_ONLY).
`;

runPublishScript({ help: HELP, platform: 'tiktok' });
