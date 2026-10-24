// Copies shared platform reference docs into every skill of that platform, so each skill
// folder is self-contained once installed. Run by "npm run build"; tests check for drift.
import { copyFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export const SHARED_REFS = [
  { source: 'docs/platforms/youtube-setup.md', prefix: 'youtube-', target: 'references/setup.md' },
  { source: 'docs/platforms/whatsapp-setup.md', prefix: 'whatsapp-', target: 'references/setup.md' },
  { source: 'docs/platforms/meta-setup.md', prefix: 'meta-', target: 'references/setup.md' },
  { source: 'docs/platforms/meta-setup.md', prefix: 'facebook-', target: 'references/setup.md' },
  { source: 'docs/platforms/meta-setup.md', prefix: 'instagram-', target: 'references/setup.md' },
  { source: 'docs/platforms/meta-setup.md', prefix: 'threads-', target: 'references/setup.md' },
];

export function syncTargets() {
  const skills = readdirSync(join(root, 'skills'));
  return SHARED_REFS.flatMap((ref) =>
    skills
      .filter((name) => name.startsWith(ref.prefix))
      .map((name) => ({ source: join(root, ref.source), target: join(root, 'skills', name, ref.target) })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const { source, target } of syncTargets()) {
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(source, target);
  }
  process.stdout.write(`synced ${syncTargets().length} reference files\n`);
}

export function readText(path) {
  return readFileSync(path, 'utf8');
}
