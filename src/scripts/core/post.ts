import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { postPlatforms } from '../../platforms/all-posting';
import { approveCheckpoint, loadState, newState, STATE_FILE, saveState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { isRemote, POST_FILE, type PostDraft, PUBLISH_CHECKPOINT, publishFiles } from '../../shared/post-project';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/post.mjs <--init|--status|--approve|--verify> --dir <post-folder> [options]

Manages a single social media post folder and its human approval. Used by every
platform posting skill (Instagram, Facebook, Threads, and later platforms).

A post folder contains:
  post.json     platform, kind, text, media, link, scheduledAt, options
  media files   referenced from post.json by relative path
  state.json    approval record (do not edit)

Approving records a SHA-256 of post.json and every local media file. Editing any of
them afterwards invalidates the approval. --approve only works in an interactive
terminal, so the account owner must run it themselves.

Actions:
  --init                 create the folder with a post.json skeleton (needs --platform and --kind)
  --status               print approval status as JSON
  --approve              show the post and ask the user to approve it; interactive
  --verify               exit 0 if approved and unchanged, else 1

Options:
  --dir <path>           post folder (required)
  --platform <id>        posting platform id (facebook, instagram, threads, x, linkedin, ...), with --init
  --kind <kind>          post kind, e.g. feed, reel, story, carousel, text, with --init
  -h, --help             show this help
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    platform: { type: 'string' },
    kind: { type: 'string' },
    init: { type: 'boolean' },
    status: { type: 'boolean' },
    approve: { type: 'boolean' },
    verify: { type: 'boolean' },
  },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));

    if (flags.init) {
      if (existsSync(join(dir, STATE_FILE)) || existsSync(join(dir, POST_FILE))) {
        throw new PlatformError('POST_EXISTS', `${dir} already contains a post; not overwriting.`);
      }
      const draft: PostDraft = {
        platform: requireFlag(flags, 'platform'),
        kind: requireFlag(flags, 'kind'),
        text: '',
        media: [],
      };
      saveState(dir, newState(`${draft.platform}-${draft.kind}`));
      writeFileSync(join(dir, POST_FILE), `${JSON.stringify(draft, null, 2)}\n`);
      printJson({
        ok: true,
        dir,
        next: `Fill in ${POST_FILE}, validate it with the platform skill, then ask the user to approve.`,
      });
      return;
    }

    const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;

    if (flags.approve) {
      const files = publishFiles(dir, draft);
      await approveCheckpoint({ dir, def: PUBLISH_CHECKPOINT, files, tty: processTty, summary: summarise(dir, draft) });
      printJson({ ok: true, approved: PUBLISH_CHECKPOINT.id, files });
      return;
    }

    const result = await verifyCheckpoint(dir, loadState(dir), PUBLISH_CHECKPOINT.id, publishFiles(dir, draft));
    printJson({
      checkpoint: PUBLISH_CHECKPOINT.id,
      ...result,
      ...(flags.status ? { history: loadState(dir).history } : {}),
    });
    if (flags.verify && !result.ok) process.exitCode = 1;
  },
);

function summarise(dir: string, draft: PostDraft): string {
  const lines = [
    `Post folder: ${dir}`,
    `Platform: ${draft.platform}    Kind: ${draft.kind}`,
    `Scheduled: ${draft.scheduledAt ?? 'no, publish immediately'}`,
  ];
  if (draft.link) lines.push(`Link: ${draft.link}`);
  lines.push('', 'Text:', ...(draft.text ?? '').split('\n').map((l) => `  ${l}`));
  if (draft.media?.length) {
    lines.push('', 'Media (open and check each one):');
    for (const m of draft.media) {
      lines.push(
        `  - ${m.type}: ${isRemote(m.source) ? m.source : join(dir, m.source)}${m.altText ? `  [alt: ${m.altText}]` : ''}`,
      );
    }
  }
  if (draft.options && Object.keys(draft.options).length > 0)
    lines.push('', `Options: ${JSON.stringify(draft.options)}`);
  const notes =
    postPlatforms()
      .find((p) => p.id === draft.platform)
      ?.approvalNotes?.(draft) ?? [];
  if (notes.length > 0) lines.push('', ...notes);
  return lines.join('\n');
}
