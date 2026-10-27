import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { postPlatform } from '../../platforms/all-posting';
import type { InboxComment } from '../../platforms/posting';
import { findPublished } from '../../platforms/published';
import { youtubeComments } from '../../platforms/youtube/engagement';
import { approveCheckpoint, loadState, newState, STATE_FILE, saveState, verifyCheckpoint } from '../../shared/approval';
import { formatError, PlatformError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/inbox.mjs <--fetch|--approve|--send> --inbox <folder> [--root <folder>]

Collects comments on everything published under --root, lets the agent draft replies,
and sends only the replies the user approved.

Inbox folder:
  comments.json   fetched comments (contains people's names and words: personal data;
                  delete the folder when done)
  replies.json    [{ "commentId": "...", "text": "..." }] written by the agent
  sent.jsonl      replies already sent; prevents double replies

Actions:
  --fetch --root <folder>   fetch comments into comments.json
  --approve                 user approves replies.json; interactive terminal only
  --send                    send the approved replies

Replying needs socialkit-meta-auth --with-engagement for Facebook, Instagram and Threads.
YouTube comments are read with YT_API_KEY; replying on YouTube is not supported.
`;

const REPLY_CHECKPOINT = { id: 'reply', title: 'Send these replies', requires: [] };

runScript(
  HELP,
  {
    inbox: { type: 'string' },
    root: { type: 'string' },
    fetch: { type: 'boolean' },
    approve: { type: 'boolean' },
    send: { type: 'boolean' },
  },
  async (flags) => {
    const inbox = resolve(requireFlag(flags, 'inbox'));
    const commentsPath = join(inbox, 'comments.json');

    if (flags.fetch) {
      const root = resolve(requireFlag(flags, 'root'));
      const comments: InboxComment[] = [];
      const errors: Array<{ platform: string; postId: string; error: string }> = [];
      for (const item of findPublished(root)) {
        try {
          const found =
            item.platform === 'youtube'
              ? await youtubeComments(item.postId)
              : await postPlatform(item.platform).comments?.(item.postId, process.env);
          comments.push(...(found ?? []));
        } catch (error) {
          errors.push({ platform: item.platform, postId: item.postId, error: formatError(error) });
        }
      }
      if (!existsSync(join(inbox, STATE_FILE))) saveState(inbox, newState('inbox'));
      writeFileSync(commentsPath, `${JSON.stringify(comments, null, 2)}\n`);
      if (!existsSync(join(inbox, 'replies.json'))) writeFileSync(join(inbox, 'replies.json'), '[]\n');
      printJson({
        ok: true,
        comments: comments.length,
        errors,
        next: 'Draft replies in replies.json, then ask the user to approve.',
      });
      return;
    }

    const comments = JSON.parse(readFileSync(commentsPath, 'utf8')) as InboxComment[];
    const replies = JSON.parse(readFileSync(join(inbox, 'replies.json'), 'utf8')) as Array<{
      commentId: string;
      text: string;
    }>;
    const byId = new Map(comments.map((c) => [c.commentId, c]));
    for (const r of replies) {
      if (!byId.has(r.commentId))
        throw new PlatformError('INBOX_UNKNOWN_COMMENT', `replies.json references unknown comment ${r.commentId}`);
      if (!r.text?.trim()) throw new PlatformError('INBOX_EMPTY_REPLY', `Reply to ${r.commentId} is empty.`);
    }

    if (flags.approve) {
      const summary = replies
        .map((r) => {
          const c = byId.get(r.commentId) as InboxComment;
          return `[${c.platform}] ${c.author}: ${c.text.slice(0, 200)}\n  -> ${r.text}`;
        })
        .join('\n\n');
      await approveCheckpoint({ dir: inbox, def: REPLY_CHECKPOINT, files: ['replies.json'], tty: processTty, summary });
      printJson({ ok: true, approved: replies.length });
      return;
    }

    if (flags.send) {
      const verified = await verifyCheckpoint(inbox, loadState(inbox), REPLY_CHECKPOINT.id, ['replies.json']);
      if (!verified.ok) {
        throw new PlatformError(
          'APPROVAL_REQUIRED',
          `Replies are not approved: ${verified.problems.join('; ')}`,
          'Ask the user to run --approve in their own terminal.',
        );
      }
      const sentPath = join(inbox, 'sent.jsonl');
      const sent = new Set(
        existsSync(sentPath)
          ? readFileSync(sentPath, 'utf8')
              .split('\n')
              .filter(Boolean)
              .map((l) => (JSON.parse(l) as { commentId: string }).commentId)
          : [],
      );
      const results: Array<Record<string, unknown>> = [];
      for (const r of replies) {
        if (sent.has(r.commentId)) continue;
        const comment = byId.get(r.commentId) as InboxComment;
        try {
          const platform = comment.platform === 'youtube' ? undefined : postPlatform(comment.platform);
          if (!platform?.reply)
            throw new PlatformError('INBOX_NO_REPLY', `Replying is not supported on ${comment.platform}.`);
          const res = await platform.reply(comment, r.text, process.env);
          appendFileSync(
            sentPath,
            `${JSON.stringify({ commentId: r.commentId, replyId: res.id, at: new Date().toISOString() })}\n`,
          );
          results.push({ commentId: r.commentId, ok: true, replyId: res.id });
        } catch (error) {
          results.push({ commentId: r.commentId, ok: false, error: formatError(error) });
          log.error(`reply failed for ${r.commentId}: ${formatError(error)}`);
        }
      }
      printJson({ results });
      if (results.some((r) => r.ok === false)) process.exitCode = 1;
      return;
    }

    process.stderr.write(`${HELP.trim()}\n`);
    process.exitCode = 2;
  },
);
