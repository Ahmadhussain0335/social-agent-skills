import { PlatformError } from '../../shared/errors';
import type { PostDraft } from '../../shared/post-project';
import type { CheckResult } from '../meta/facebook';
import { registerPostPlatform } from '../posting';

// Reddit is draft-only by design. Since the Responsible Builder Policy (2025-11-11) API
// access needs Reddit's explicit approval and is aimed at moderation; automated posting
// across subreddits is treated as spam. This skill prepares a draft that respects the
// subreddit's rules; the user posts it themselves on reddit.com.

export function checkRedditDraft(draft: PostDraft): CheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const o = draft.options ?? {};
  if (draft.platform !== 'reddit') errors.push('platform must be "reddit"');
  if (!['self', 'link'].includes(draft.kind)) errors.push('kind must be "self" (text post) or "link"');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(String(o.subreddit ?? '')))
    errors.push('options.subreddit must be a subreddit name without r/');
  const title = String(o.title ?? '');
  if (!title.trim()) errors.push('options.title is required');
  if ([...title].length > 300) errors.push('options.title exceeds 300 characters');
  if (draft.kind === 'link' && !draft.link) errors.push('link posts need "link"');
  if ((draft.text ?? '').length > 40000) errors.push('text exceeds 40,000 characters');
  if (!o.rulesChecked)
    warnings.push('confirm the subreddit rules were read (set options.rulesChecked to true after checking)');
  if (/\b(buy now|limited offer|discount code)\b/i.test(draft.text ?? ''))
    warnings.push('promotional wording is banned in many subreddits');
  return { ok: errors.length === 0, errors, warnings };
}

registerPostPlatform({
  id: 'reddit',
  label: 'Reddit (draft only)',
  kinds: ['self', 'link'],
  textLimit: 40000,
  scheduling: false,
  notes: [
    'Draft only: the user posts on reddit.com. Reddit API access requires approval and targets moderation.',
    'Read the subreddit rules first; many ban self-promotion or require flair.',
    'Never post the same text to several subreddits.',
  ],
  check: (draft) => checkRedditDraft(draft),
  async publish() {
    throw new PlatformError(
      'REDDIT_DRAFT_ONLY',
      'Reddit posts are not published automatically.',
      'Open the draft with the socialkit-reddit-draft skill, post it on reddit.com yourself, then record the URL with --mark-posted.',
    );
  },
});
