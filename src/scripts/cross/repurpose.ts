import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { postPlatform, postPlatforms } from '../../platforms/all-posting';
import { newState, saveState } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { POST_FILE, type PostDraft } from '../../shared/post-project';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage:
  node scripts/repurpose.mjs --guide [--platforms <ids>]
  node scripts/repurpose.mjs --init --source <file> --out <folder> --platforms <ids>
  node scripts/repurpose.mjs --check --out <folder>

Turns one source (script, blog post, transcript, notes) into one draft post folder per
platform, each with its own post.json, approval and publish step. The agent writes the
text for each platform; this script provides the limits, creates the folders and
validates them.

Actions:
  --guide     print per-platform limits, post kinds and drafting notes as JSON
  --init      create <out>/source.<ext> and <out>/<platform>/post.json for each platform
  --check     validate every post folder under <out> with its platform rules

Options:
  --platforms <ids>   comma-separated, e.g. facebook,instagram,threads
  --source <file>     the source document (copied into the output folder)
  --out <folder>      output folder
`;

const DEFAULT_KIND: Record<string, string> = { facebook: 'text', instagram: 'image', threads: 'text' };

runScript(
  HELP,
  {
    guide: { type: 'boolean' },
    init: { type: 'boolean' },
    check: { type: 'boolean' },
    platforms: { type: 'string' },
    source: { type: 'string' },
    out: { type: 'string' },
  },
  (flags) => {
    const ids =
      typeof flags.platforms === 'string'
        ? flags.platforms
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined;

    if (flags.guide) {
      const platforms = ids ? ids.map(postPlatform) : postPlatforms();
      printJson(
        platforms.map((p) => ({
          id: p.id,
          label: p.label,
          textLimit: p.textLimit,
          kinds: p.kinds,
          scheduling: p.scheduling,
          notes: p.notes,
        })),
      );
      return;
    }

    const out = resolve(requireFlag(flags, 'out'));

    if (flags.init) {
      if (!ids?.length) throw new PlatformError('REPURPOSE_PLATFORMS', 'Pass --platforms, e.g. facebook,threads');
      const source = resolve(requireFlag(flags, 'source'));
      if (!existsSync(source)) throw new PlatformError('FILE_MISSING', `Source not found: ${source}`);
      mkdirSync(out, { recursive: true });
      copyFileSync(source, join(out, `source-${basename(source)}`));
      const created: string[] = [];
      for (const id of ids) {
        const platform = postPlatform(id);
        const dir = join(out, id);
        if (existsSync(join(dir, POST_FILE))) continue;
        mkdirSync(dir, { recursive: true });
        const draft: PostDraft = {
          platform: id,
          kind: DEFAULT_KIND[id] ?? platform.kinds[0] ?? 'text',
          text: '',
          media: [],
        };
        saveState(dir, newState(`${id}-repurpose`));
        writeFileSync(join(dir, POST_FILE), `${JSON.stringify(draft, null, 2)}\n`);
        created.push(dir);
      }
      printJson({
        ok: true,
        source: join(out, `source-${basename(source)}`),
        created,
        next: 'Write each post.json from the source, then run --check.',
      });
      return;
    }

    if (flags.check) {
      const results = readdirSync(out, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(out, e.name, POST_FILE)))
        .map((e) => {
          const draft = JSON.parse(readFileSync(join(out, e.name, POST_FILE), 'utf8')) as PostDraft;
          const report = postPlatform(draft.platform).check(draft);
          return { folder: e.name, platform: draft.platform, kind: draft.kind, ...report };
        });
      printJson({ ok: results.every((r) => r.ok), results });
      if (!results.every((r) => r.ok)) process.exitCode = 1;
      return;
    }

    process.stderr.write(`${HELP.trim()}\n`);
    process.exitCode = 2;
  },
);
