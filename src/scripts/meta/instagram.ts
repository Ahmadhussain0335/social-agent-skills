import { runPublishScript } from './publish-runner';

const HELP = `
Usage: node scripts/publish.mjs <--check|--publish> --dir <post-folder> [--allow-repost]

Publishes post.json to an Instagram Business or Creator account linked to a Facebook
Page, through the official Instagram Graph API. --publish requires the user's approval
(social-core post.mjs --approve) and refuses to post the same folder twice.

post.json kinds:
  image     one JPEG at a public https URL
  carousel  2-10 items (images by https URL; videos by https URL)
  reel      one MP4/MOV video, local file (uploaded directly) or https URL
  story     one image (https URL) or video (local or https)

Caption: 2,200 characters, 30 hashtags, 20 @mentions. No scheduling via the API.
options.instagramAccountId: required when several Instagram accounts are linked.
`;

runPublishScript({ help: HELP, platform: 'instagram' });
