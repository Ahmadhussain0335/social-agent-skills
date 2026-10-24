import '../../platforms/x';
import { runPublishScript } from '../publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to X through its official API. --publish requires the user's
approval (social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  text    up to 280 weighted characters (URLs count 23)
  media   text plus up to 4 local images or 1 local video
  poll    options.poll = { "options": ["A","B"], "durationMinutes": 1440 }
Flags in options: madeWithAi, paidPartnership. No API scheduling.
Cost: pay-per-use, about $0.015 per post or $0.20 with a link (checked 2026-10-24); shown at approval.
`;

runPublishScript({ help: HELP, platform: 'x' });
