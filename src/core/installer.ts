import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createTwoFilesPatch } from 'diff';
import type { BundledSkill } from './catalog';
import { hashTree, type InstallManifest, inspectInstalled, MANIFEST_FILE, type SkillState } from './manifest';

export interface InstallContext {
  packageName: string;
  version: string;
  /** Where replaced or removed user-modified skills are moved instead of being deleted. */
  backupRoot: string;
  force: boolean;
  now?: Date;
}

export type InstallAction = 'installed' | 'updated' | 'unchanged' | 'skipped' | 'replaced';
export type UninstallAction = 'removed' | 'absent' | 'skipped';

export interface Outcome<A> {
  skill: string;
  dir: string;
  action: A;
  reason?: string;
  diff?: string;
  backup?: string;
}

const MAX_DIFF_LINES = 60;

export function installSkill(source: BundledSkill, skillsDir: string, ctx: InstallContext): Outcome<InstallAction> {
  const dest = join(skillsDir, source.name);
  const state = inspectInstalled(dest, ctx.packageName);
  const base = { skill: source.name, dir: dest };

  switch (state.kind) {
    case 'absent':
      copySkill(source, dest, ctx);
      return { ...base, action: 'installed' };
    case 'clean': {
      if (state.manifest.version === ctx.version && sameFiles(state.manifest.files, hashTree(source.dir))) {
        return { ...base, action: 'unchanged' };
      }
      rmSync(dest, { recursive: true, force: true });
      copySkill(source, dest, ctx);
      return { ...base, action: 'updated' };
    }
    case 'modified':
    case 'unmanaged': {
      const diff = describeChanges(source.dir, dest, state);
      if (!ctx.force) {
        return { ...base, action: 'skipped', reason: reasonFor(state), diff };
      }
      const backup = moveToBackup(dest, source.name, ctx);
      copySkill(source, dest, ctx);
      return { ...base, action: 'replaced', reason: reasonFor(state), diff, backup };
    }
  }
}

export function uninstallSkill(name: string, skillsDir: string, ctx: InstallContext): Outcome<UninstallAction> {
  const dest = join(skillsDir, name);
  const state = inspectInstalled(dest, ctx.packageName);
  const base = { skill: name, dir: dest };

  switch (state.kind) {
    case 'absent':
      return { ...base, action: 'absent' };
    case 'clean':
      rmSync(dest, { recursive: true, force: true });
      return { ...base, action: 'removed' };
    case 'modified':
    case 'unmanaged':
      if (!ctx.force) return { ...base, action: 'skipped', reason: reasonFor(state) };
      return { ...base, action: 'removed', reason: reasonFor(state), backup: moveToBackup(dest, name, ctx) };
  }
}

function copySkill(source: BundledSkill, dest: string, ctx: InstallContext): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  rmSync(tmp, { recursive: true, force: true });
  cpSync(source.dir, tmp, { recursive: true });
  const manifest: InstallManifest = {
    package: ctx.packageName,
    version: ctx.version,
    skill: source.name,
    installedAt: (ctx.now ?? new Date()).toISOString(),
    files: hashTree(tmp),
  };
  writeFileSync(join(tmp, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(tmp, dest);
}

function moveToBackup(dir: string, name: string, ctx: InstallContext): string {
  const stamp = (ctx.now ?? new Date()).toISOString().replace(/[:.]/g, '-');
  const target = join(ctx.backupRoot, stamp, name);
  mkdirSync(join(ctx.backupRoot, stamp), { recursive: true });
  try {
    renameSync(dir, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    cpSync(dir, target, { recursive: true });
    rmSync(dir, { recursive: true, force: true });
  }
  return target;
}

function sameFiles(a: Record<string, string>, b: Record<string, string>): boolean {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

function reasonFor(state: SkillState): string {
  if (state.kind === 'unmanaged') return 'directory exists but was not installed by social-skills';
  if (state.kind !== 'modified') return '';
  const parts = [
    state.changed.length ? `changed: ${state.changed.join(', ')}` : '',
    state.added.length ? `added: ${state.added.join(', ')}` : '',
    state.removed.length ? `removed: ${state.removed.join(', ')}` : '',
  ].filter(Boolean);
  return `local modifications (${parts.join('; ')})`;
}

/** Diff of the user's copy against the package version, i.e. what an overwrite would discard. */
function describeChanges(sourceDir: string, dest: string, state: SkillState): string {
  const files = state.kind === 'modified' ? [...state.changed, ...state.added] : Object.keys(hashTree(dest));
  const chunks: string[] = [];
  for (const file of files) {
    const local = readFileSync(join(dest, file), 'utf8');
    const packaged = existsSync(join(sourceDir, file)) ? readFileSync(join(sourceDir, file), 'utf8') : '';
    const patch = createTwoFilesPatch(`yours/${file}`, `package/${file}`, local, packaged, '', '', {
      context: 2,
    });
    const lines = patch.split('\n');
    chunks.push(
      lines.length > MAX_DIFF_LINES
        ? [...lines.slice(0, MAX_DIFF_LINES), `... ${lines.length - MAX_DIFF_LINES} more lines`].join('\n')
        : patch,
    );
  }
  return chunks.join('\n');
}
