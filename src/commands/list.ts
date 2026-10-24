import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Scope } from '../agents';
import { bundledSkills } from '../core/catalog';
import { inspectInstalled, MANIFEST_FILE } from '../core/manifest';
import { allKnownDirs, type CliContext, scopeRootDir } from './context';

export interface InstalledSkill {
  scope: Scope;
  skillsDir: string;
  skill: string;
  version: string;
  state: 'clean' | 'modified';
}

/** Finds skills installed by this package in every directory a supported agent reads. */
export function findInstalled(ctx: CliContext, scopes: readonly Scope[]): InstalledSkill[] {
  const found: InstalledSkill[] = [];
  // Running from the home directory makes project and global dirs identical; scan each once.
  const seen = new Set<string>();
  for (const scope of scopes) {
    for (const dir of allKnownDirs(scope)) {
      const skillsDir = join(scopeRootDir(scope, ctx), dir);
      if (seen.has(skillsDir) || !existsSync(skillsDir)) continue;
      seen.add(skillsDir);
      for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !existsSync(join(skillsDir, entry.name, MANIFEST_FILE))) continue;
        const state = inspectInstalled(join(skillsDir, entry.name), ctx.packageName);
        if (state.kind === 'clean' || state.kind === 'modified') {
          found.push({
            scope,
            skillsDir,
            skill: entry.name,
            version: state.manifest.version,
            state: state.kind,
          });
        }
      }
    }
  }
  return found;
}

export function runList(ctx: CliContext): void {
  ctx.out(`Skills in ${ctx.packageName}@${ctx.version}:`);
  for (const skill of bundledSkills(ctx.skillsRoot)) {
    const summary = skill.description.length > 100 ? `${skill.description.slice(0, 97)}...` : skill.description;
    ctx.out(`  ${skill.name.padEnd(20)} ${summary}`);
  }

  const installed = findInstalled(ctx, ['project', 'global']);
  ctx.out('\nInstalled:');
  if (installed.length === 0) {
    ctx.out('  none found in this project or your home directory');
    return;
  }
  for (const item of installed) {
    const flag = item.state === 'modified' ? ' (modified locally)' : '';
    const stale = item.version !== ctx.version ? ` (package has ${ctx.version})` : '';
    ctx.out(`  [${item.scope}] ${join(item.skillsDir, item.skill)}  v${item.version}${stale}${flag}`);
  }
}
