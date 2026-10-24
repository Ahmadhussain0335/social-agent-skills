import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataList, parseSkillFile } from './frontmatter';

export interface BundledSkill {
  name: string;
  description: string;
  dir: string;
  requires: string[];
}

export interface PackageInfo {
  root: string;
  name: string;
  version: string;
}

/** Walks up from this file to the package root, which works from src/ (tests) and dist/. */
export function packageInfo(from = dirname(fileURLToPath(import.meta.url))): PackageInfo {
  let dir = from;
  for (;;) {
    const pkgPath = join(dir, 'package.json');
    if (existsSync(pkgPath) && existsSync(join(dir, 'skills'))) {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name: string; version: string };
      return { root: dir, name: pkg.name, version: pkg.version };
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('Could not locate the social-skills package root');
    dir = parent;
  }
}

export function bundledSkills(skillsRoot = join(packageInfo().root, 'skills')): BundledSkill[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => {
      const dir = join(skillsRoot, entry.name);
      const { frontmatter } = parseSkillFile(readFileSync(join(dir, 'SKILL.md'), 'utf8'));
      return {
        name: entry.name,
        description: String(frontmatter.description ?? ''),
        dir,
        requires: metadataList(frontmatter, 'requires'),
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Expands a selection with every skill it requires, transitively. */
export function withDependencies(selected: readonly string[], all: readonly BundledSkill[]): BundledSkill[] {
  const byName = new Map(all.map((skill) => [skill.name, skill]));
  const result = new Map<string, BundledSkill>();
  const visit = (name: string) => {
    if (result.has(name)) return;
    const skill = byName.get(name);
    if (!skill) {
      throw new Error(`Unknown skill "${name}". Available: ${all.map((s) => s.name).join(', ')}`);
    }
    result.set(name, skill);
    skill.requires.forEach(visit);
  };
  selected.forEach(visit);
  return [...result.values()].sort((a, b) => a.name.localeCompare(b.name));
}
