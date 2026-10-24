# Platform limits

Hard limits are enforced by each platform skill's validation script. This table is the
quick reference. Later releases add rows per platform.

## YouTube

| Field | Limit | Source |
| - | - | - |
| Title | 100 characters, no `<` or `>` | YouTube Data API video resource, snippet.title |
| Description | 5000 bytes, no `<` or `>` | snippet.description |
| Tags | 500 characters total; tags with spaces count their quotes; commas count | snippet.tags |
| Thumbnail | JPEG or PNG, up to 2 MB, 1280x720 recommended, at least 640 px wide | thumbnails.set |
| Made for kids | must be declared on every upload | status.selfDeclaredMadeForKids |
| Scheduled publish | video must be private until publishAt | status.publishAt |
| Uploads via API | 100 videos.insert calls per day per project (default) | quota cost table |
| Custom thumbnails | channel must be verified | YouTube Help |

Quota resets at midnight Pacific Time.

## Account requirements and API access (reference for later phases)

| Platform | Constraint |
| - | - |
| X | Write access requires a paid API tier |
| Instagram | Business or Creator account linked to a Facebook Page |
| Facebook | Pages only; no posting to personal profiles |
| LinkedIn | Company page posting needs additional API product approval |
| TikTok | Content posting API uploads are private until the app passes audit |
| Reddit | Strict API terms and per-subreddit rules; draft-only by default |
| WhatsApp | Business Platform Cloud API only; opt-in and 24-hour window rules |
