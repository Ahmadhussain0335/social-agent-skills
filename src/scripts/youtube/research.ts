import { apiKeyClient } from '../../platforms/youtube/client';
import { type ResearchQuery, researchVideos } from '../../platforms/youtube/research';
import { printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/research.mjs --query <text> [options]

Searches YouTube with the official Data API v3 and prints the top videos with
statistics as JSON. Read-only. Uses YT_API_KEY.

Quota: 1 search.list call (search bucket, 100 calls/day) + 1 videos.list unit.

Options:
  --query <text>            search terms (required)
  --max <n>                 results, 1-50 (default 10)
  --order <order>           relevance | viewCount | date | rating (default relevance)
  --published-after <iso>   only videos published after this date, e.g. 2026-01-01T00:00:00Z
  --region <code>           ISO 3166-1 alpha-2 region, e.g. US
  --language <code>         ISO 639-1 relevance language, e.g. en
  -h, --help                show this help

Environment:
  YT_API_KEY                API key restricted to YouTube Data API v3 (required)
`;

runScript(
  HELP,
  {
    query: { type: 'string' },
    max: { type: 'string' },
    order: { type: 'string' },
    'published-after': { type: 'string' },
    region: { type: 'string' },
    language: { type: 'string' },
  },
  async (flags) => {
    const videos = await researchVideos(apiKeyClient(), {
      query: requireFlag(flags, 'query'),
      max: flags.max ? Number(flags.max) : undefined,
      order: flags.order as ResearchQuery['order'],
      publishedAfter: flags['published-after'] as string | undefined,
      regionCode: flags.region as string | undefined,
      language: flags.language as string | undefined,
    });
    printJson({ query: flags.query, count: videos.length, videos });
  },
);
