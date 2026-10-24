import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// Every installed skill gets a manifest with the hash of each file at install time.
// Comparing against it tells us whether the user edited the skill since, so we never
// overwrite or remove their changes without --force.

export const MANIFEST_FILE = '.social-skills.json';

export interface InstallManifest {
  package: string;
  version: string;
  skill: string;
  installedAt: string;
  files: Record<string, string>;
}

export type SkillState =
  | { kind: 'absent' }
  | { kind: 'unmanaged' }
  | { kind: 'clean'; manifest: InstallManifest }
  | { kind: 'modified'; manifest: InstallManifest; changed: string[]; added: string[]; removed: string[] };

export function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Relative POSIX paths of every file under dir, excluding the manifest. */
export function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) out.push(relative(dir, path).split(sep).join('/'));
    }
  };
  walk(dir);
  return out.filter((file) => file !== MANIFEST_FILE).sort();
}

export function hashTree(dir: string): Record<string, string> {
  return Object.fromEntries(listFiles(dir).map((file) => [file, sha256(readFileSync(join(dir, file)))]));
}

export function readManifest(skillDir: string): InstallManifest | undefined {
  const path = join(skillDir, MANIFEST_FILE);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as InstallManifest;
  } catch {
    return undefined;
  }
}

export function inspectInstalled(skillDir: string, packageName: string): SkillState {
  if (!existsSync(skillDir)) return { kind: 'absent' };
  const manifest = readManifest(skillDir);
  if (!manifest || manifest.package !== packageName) return { kind: 'unmanaged' };

  const current = hashTree(skillDir);
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];
  for (const [file, hash] of Object.entries(manifest.files)) {
    if (!(file in current)) removed.push(file);
    else if (current[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(current)) {
    if (!(file in manifest.files)) added.push(file);
  }
  if (changed.length + added.length + removed.length === 0) return { kind: 'clean', manifest };
  return { kind: 'modified', manifest, changed, added, removed };
}
