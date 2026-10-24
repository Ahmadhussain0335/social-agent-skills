import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { checkRedditDraft } from '../../platforms/reddit';
import { loadState, saveState } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { POST_FILE, type PostDraft } from '../../shared/post-project';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage:
  node scripts/draft.mjs --check --dir <post-folder>
  node scripts/draft.mjs --show --dir <post-folder>
  node scripts/draft.mjs --mark-posted --url <reddit post URL> --dir <post-folder>

Reddit is draft-only: nothing is posted through the API. --show prints the final text
and a reddit.com submit link with the title and text filled in, for the user to review
and post themselves. --mark-posted records the URL so analytics and the calendar know.

post.json: platform "reddit", kind "self" or "link", text (body), link,
options.subreddit (without r/), options.title (300), options.flair, options.rulesChecked.
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    check: { type: 'boolean' },
    show: { type: 'boolean' },
    'mark-posted': { type: 'boolean' },
    url: { type: 'string' },
  },
  (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));
    const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;
    const report = checkRedditDraft(draft);

    if (flags['mark-posted']) {
      const url = requireFlag(flags, 'url');
      if (!/^https:\/\/(www\.|old\.)?reddit\.com\/r\/[^/]+\/comments\//.test(url)) {
        throw new PlatformError(
          'REDDIT_URL',
          'Pass the URL of the published Reddit post (https://www.reddit.com/r/<sub>/comments/...).',
        );
      }
      const state = loadState(dir);
      state.history.push({ at: new Date().toISOString(), event: 'published', detail: url });
      saveState(dir, state);
      printJson({ ok: true, recorded: url });
      return;
    }
    if (flags.show) {
      if (!report.ok) throw new PlatformError('REDDIT_DRAFT_INVALID', report.errors.join('; '));
      const o = draft.options ?? {};
      const submit = new URL(`https://www.reddit.com/r/${o.subreddit}/submit`);
      submit.searchParams.set('title', String(o.title));
      if (draft.kind === 'link' && draft.link) submit.searchParams.set('url', draft.link);
      else submit.searchParams.set('text', draft.text ?? '');
      printJson({
        subreddit: `r/${o.subreddit}`,
        title: o.title,
        body: draft.kind === 'self' ? draft.text : undefined,
        link: draft.kind === 'link' ? draft.link : undefined,
        flair: o.flair,
        submitUrl: submit.toString(),
        warnings: report.warnings,
        next: 'Open submitUrl, check everything, choose flair if required, and post. Then run --mark-posted with the post URL.',
      });
      return;
    }
    printJson(report);
    if (!report.ok) process.exitCode = 1;
  },
);
