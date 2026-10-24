import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { CHECKPOINTS, checkpointDef, checkpointFiles, FILES } from '../../platforms/youtube/pipeline';
import { approveCheckpoint, loadState, newState, STATE_FILE, saveState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { processTty } from '../../shared/prompt';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/state.mjs <--init|--status|--approve|--verify> --dir <project-folder> [options]

Tracks a YouTube video project and its three human approval checkpoints:
  script    1/3 script draft                      covers script.md
  metadata  2/3 title, description, thumbnail     covers metadata.json and the thumbnail
  upload    3/3 final video and upload settings   covers the video, metadata.json, thumbnail, upload-plan.json

Each approval stores a SHA-256 of the covered files. Editing any of them afterwards
invalidates the approval. --approve only works in an interactive terminal, so the
person who owns the channel must run it themselves.

Actions:
  --init                 create <dir>/state.json (needs --slug)
  --status               print checkpoint status as JSON
  --approve <id>         approve a checkpoint (script | metadata | upload); interactive
  --verify <id>          exit 0 if the checkpoint is approved and files are unchanged, else 1

Options:
  --dir <path>           project folder (required)
  --slug <name>          short project name, with --init
  -h, --help             show this help
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    slug: { type: 'string' },
    init: { type: 'boolean' },
    status: { type: 'boolean' },
    approve: { type: 'string' },
    verify: { type: 'string' },
  },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));

    if (flags.init) {
      if (existsSync(join(dir, STATE_FILE))) {
        throw new PlatformError('STATE_EXISTS', `${STATE_FILE} already exists in ${dir}; not overwriting.`);
      }
      const slug = requireFlag(flags, 'slug');
      saveState(dir, newState(slug));
      printJson({
        ok: true,
        dir,
        slug,
        next: `Write ${FILES.script}, then ask the user to approve the "script" checkpoint.`,
      });
      return;
    }

    if (typeof flags.approve === 'string') {
      const def = checkpointDef(flags.approve);
      const files = checkpointFiles(dir, def.id);
      await approveCheckpoint({ dir, def, files, tty: processTty, summary: summarise(dir, def.id, files) });
      printJson({ ok: true, approved: def.id, files });
      return;
    }

    if (typeof flags.verify === 'string') {
      const def = checkpointDef(flags.verify);
      const result = await verifyCheckpoint(dir, loadState(dir), def.id, checkpointFiles(dir, def.id));
      printJson({ checkpoint: def.id, ...result });
      if (!result.ok) process.exitCode = 1;
      return;
    }

    const state = loadState(dir);
    const status: Record<string, unknown> = {};
    for (const def of CHECKPOINTS) {
      let files: string[] = [];
      try {
        files = checkpointFiles(dir, def.id);
      } catch {
        // inputs for this checkpoint do not exist yet
      }
      const result = state.checkpoints[def.id]
        ? await verifyCheckpoint(dir, state, def.id, files)
        : { ok: false, problems: ['not approved'] };
      status[def.id] = { title: def.title, approved: result.ok, problems: result.problems };
    }
    printJson({ slug: state.slug, dir, checkpoints: status, history: state.history });
  },
);

function summarise(dir: string, checkpoint: string, files: string[]): string {
  const lines = [`Project: ${dir}`, 'Files covered by this approval:', ...files.map((f) => `  - ${f}`)];
  if (checkpoint === 'metadata' || checkpoint === 'upload') {
    const meta = JSON.parse(readFileSync(join(dir, FILES.metadata), 'utf8')) as Record<string, unknown>;
    lines.push(
      '',
      `Title: ${meta.title}`,
      `Made for kids: ${meta.madeForKids}`,
      `Tags: ${(meta.tags as string[] | undefined)?.join(', ') ?? ''}`,
    );
    lines.push(
      'Description:',
      String(meta.description ?? '')
        .split('\n')
        .slice(0, 15)
        .map((l) => `  ${l}`)
        .join('\n'),
    );
  }
  if (checkpoint === 'upload') {
    const plan = JSON.parse(readFileSync(join(dir, FILES.uploadPlan), 'utf8')) as Record<string, unknown>;
    lines.push(
      '',
      `Video file: ${plan.file}`,
      `Privacy: ${plan.privacyStatus}`,
      `Scheduled: ${plan.publishAt ?? 'no'}`,
      `AI/synthetic content disclosed: ${plan.containsSyntheticMedia ? 'yes' : 'NO'}`,
      `Notify subscribers: ${plan.notifySubscribers ? 'yes' : 'no'}`,
      '',
      'Watch the final video file before approving.',
    );
  }
  return lines.join('\n');
}
