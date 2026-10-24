import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstall } from '../src/commands/install';
import { findInstalled, runList } from '../src/commands/list';
import { runUninstall } from '../src/commands/uninstall';
import { runUpdate } from '../src/commands/update';
import { bundledSkills, withDependencies } from '../src/core/catalog';
import { MANIFEST_FILE } from '../src/core/manifest';
import { fakeTty, testContext } from './helpers';

const ALL = bundledSkills(join(import.meta.dirname, '..', 'skills')).map((s) => s.name);

describe('install', () => {
  it('installs every skill into the minimal set of project directories', async () => {
    const ctx = testContext();
    const outcomes = await runInstall({ project: true, agent: ['claude-code', 'codex'] }, ctx);

    for (const dir of ['.claude/skills', '.agents/skills']) {
      for (const skill of ALL) {
        expect(existsSync(join(ctx.cwd, dir, skill, 'SKILL.md'))).toBe(true);
        expect(existsSync(join(ctx.cwd, dir, skill, MANIFEST_FILE))).toBe(true);
      }
    }
    expect(outcomes.every((o) => o.action === 'installed')).toBe(true);
    expect(existsSync(join(ctx.cwd, '.cursor'))).toBe(false);
  });

  it('installs into the home directory with --global', async () => {
    const ctx = testContext();
    await runInstall({ global: true, agent: ['gemini-cli'], skill: ['social-core'] }, ctx);
    expect(existsSync(join(ctx.home, '.agents/skills/social-core/SKILL.md'))).toBe(true);
  });

  it('adds required skills such as social-core to a --skill selection', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['youtube-script'] }, ctx);
    expect(existsSync(join(ctx.cwd, '.claude/skills/youtube-script'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/social-core'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/youtube-upload'))).toBe(false);
  });

  it('reports unchanged on a second run', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    const again = await runInstall({ project: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    expect(again.map((o) => o.action)).toEqual(['unchanged']);
  });

  it('never overwrites a modified skill without --force and shows a diff', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    const skillFile = join(ctx.cwd, '.claude/skills/social-core/SKILL.md');
    appendFileSync(skillFile, '\nMy custom rule.\n');

    const skipped = await runInstall({ project: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    expect(skipped[0]?.action).toBe('skipped');
    expect(skipped[0]?.diff).toContain('-My custom rule.');
    expect(readFileSync(skillFile, 'utf8')).toContain('My custom rule.');
    expect(ctx.stderr.join('\n')).toMatch(/--force/);

    const forced = await runInstall(
      { project: true, agent: ['claude-code'], skill: ['social-core'], force: true },
      ctx,
    );
    expect(forced[0]?.action).toBe('replaced');
    expect(readFileSync(skillFile, 'utf8')).not.toContain('My custom rule.');
    const backup = forced[0]?.backup as string;
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toContain('My custom rule.');
    expect(backup.startsWith(ctx.env.SOCIAL_SKILLS_CONFIG_DIR as string)).toBe(true);
  });

  it('treats an existing folder it did not install as user-owned', async () => {
    const ctx = testContext();
    const own = join(ctx.cwd, '.claude/skills/social-core/SKILL.md');
    await import('node:fs').then((fs) =>
      fs.mkdirSync(join(ctx.cwd, '.claude/skills/social-core'), { recursive: true }),
    );
    writeFileSync(own, 'mine');
    const outcome = await runInstall({ project: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    expect(outcome[0]?.action).toBe('skipped');
    expect(readFileSync(own, 'utf8')).toBe('mine');
  });

  it('requires --agent or --yes without a terminal', async () => {
    await expect(runInstall({ project: true }, testContext())).rejects.toThrow(/--agent/);
  });

  it('asks for scope and agents in a terminal', async () => {
    const ctx = testContext({ tty: fakeTty(['g', '1']) });
    await runInstall({ skill: ['social-core'] }, ctx);
    expect(existsSync(join(ctx.home, '.claude/skills/social-core'))).toBe(true);
  });
});

describe('update', () => {
  it('re-copies clean installs from an older version and skips modified ones', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['youtube-script'] }, ctx);
    appendFileSync(join(ctx.cwd, '.claude/skills/youtube-script/SKILL.md'), '\nlocal\n');

    const newer = { ...ctx, version: '0.2.0' };
    const outcomes = runUpdate({ project: true }, newer);
    const byName = Object.fromEntries(outcomes.map((o) => [o.skill, o.action]));
    expect(byName).toEqual({ 'social-core': 'updated', 'youtube-script': 'skipped' });
  });
});

describe('uninstall', () => {
  it('removes clean skills and keeps modified ones unless forced', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['youtube-script'] }, ctx);
    appendFileSync(join(ctx.cwd, '.claude/skills/youtube-script/SKILL.md'), '\nlocal\n');

    const first = await runUninstall({ project: true, agent: ['claude-code'] }, ctx);
    expect(first.filter((o) => o.action !== 'absent').map((o) => [o.skill, o.action])).toEqual([
      ['social-core', 'removed'],
      ['youtube-script', 'skipped'],
    ]);

    const forced = await runUninstall({ project: true, agent: ['claude-code'], force: true }, ctx);
    const script = forced.find((o) => o.skill === 'youtube-script');
    expect(script?.action).toBe('removed');
    expect(existsSync(join(script?.backup as string, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/youtube-script'))).toBe(false);
  });
});

describe('uninstall input', () => {
  it('rejects skill names that could escape the skills directory', async () => {
    await expect(
      runUninstall({ project: true, agent: ['claude-code'], skill: ['../../etc'], force: true }, testContext()),
    ).rejects.toThrow(/Invalid skill name/);
  });
});

describe('list', () => {
  it('shows bundled and installed skills', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['cursor'], skill: ['social-core'] }, ctx);
    runList(ctx);
    expect(ctx.stdout.join('\n')).toMatch(/youtube-upload/);
    expect(findInstalled(ctx, ['project'])).toEqual([
      expect.objectContaining({ skill: 'social-core', state: 'clean', version: '0.1.0' }),
    ]);
  });
});

describe('findInstalled from the home directory', () => {
  it('reports each install once when project and global roots coincide', async () => {
    const base = testContext();
    const ctx = { ...base, cwd: base.home };
    await runInstall({ global: true, agent: ['claude-code'], skill: ['social-core'] }, ctx);
    expect(findInstalled(ctx, ['project', 'global'])).toHaveLength(1);
  });
});

describe('withDependencies', () => {
  it('expands transitively and rejects unknown skills', () => {
    const all = bundledSkills(join(import.meta.dirname, '..', 'skills'));
    expect(withDependencies(['youtube-pipeline'], all).map((s) => s.name)).toEqual(ALL);
    expect(() => withDependencies(['nope'], all)).toThrow(/Unknown skill "nope"/);
  });
});
