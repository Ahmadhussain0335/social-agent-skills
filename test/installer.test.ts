import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInstall } from '../src/commands/install';
import { findInstalled, runList } from '../src/commands/list';
import { runUninstall } from '../src/commands/uninstall';
import { runUpdate } from '../src/commands/update';
import { bundledSkills, withDependencies } from '../src/core/catalog';
import { installSkill } from '../src/core/installer';
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
    await runInstall({ global: true, agent: ['gemini-cli'], skill: ['socialkit-social-core'] }, ctx);
    expect(existsSync(join(ctx.home, '.agents/skills/socialkit-social-core/SKILL.md'))).toBe(true);
  });

  it('adds required skills such as socialkit-social-core to a --skill selection', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-youtube-script'] }, ctx);
    expect(existsSync(join(ctx.cwd, '.claude/skills/socialkit-youtube-script'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/socialkit-social-core'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/socialkit-youtube-upload'))).toBe(false);
  });

  it('reports unchanged on a second run', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    const again = await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    expect(again.map((o) => o.action)).toEqual(['unchanged']);
  });

  it('never overwrites a modified skill without --force and shows a diff', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    const skillFile = join(ctx.cwd, '.claude/skills/socialkit-social-core/SKILL.md');
    appendFileSync(skillFile, '\nMy custom rule.\n');

    const skipped = await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    expect(skipped[0]?.action).toBe('skipped');
    expect(skipped[0]?.diff).toContain('-My custom rule.');
    expect(readFileSync(skillFile, 'utf8')).toContain('My custom rule.');
    expect(ctx.stderr.join('\n')).toMatch(/--force/);

    const forced = await runInstall(
      { project: true, agent: ['claude-code'], skill: ['socialkit-social-core'], force: true },
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
    const own = join(ctx.cwd, '.claude/skills/socialkit-social-core/SKILL.md');
    await import('node:fs').then((fs) =>
      fs.mkdirSync(join(ctx.cwd, '.claude/skills/socialkit-social-core'), { recursive: true }),
    );
    writeFileSync(own, 'mine');
    const outcome = await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    expect(outcome[0]?.action).toBe('skipped');
    expect(readFileSync(own, 'utf8')).toBe('mine');
  });

  it('requires --agent or --yes without a terminal', async () => {
    await expect(runInstall({ project: true }, testContext())).rejects.toThrow(/--agent/);
  });

  it('asks for scope and agents in a terminal', async () => {
    const ctx = testContext({ tty: fakeTty(['g', '1']) });
    await runInstall({ skill: ['socialkit-social-core'] }, ctx);
    expect(existsSync(join(ctx.home, '.claude/skills/socialkit-social-core'))).toBe(true);
  });
});

describe('update from 0.1.0 names', () => {
  // Simulates a 0.1.0 install, where skills had no socialkit- prefix.
  function installOldName(ctx: ReturnType<typeof testContext>, oldName: string) {
    const current = bundledSkills(ctx.skillsRoot).find((s) => s.name === `socialkit-${oldName}`);
    if (!current) throw new Error(`no bundled socialkit-${oldName}`);
    const skillsDir = join(ctx.cwd, '.claude/skills');
    installSkill({ ...current, name: oldName }, skillsDir, {
      packageName: ctx.packageName,
      version: '0.1.0',
      backupRoot: join(String(ctx.env.SOCIAL_SKILLS_CONFIG_DIR), 'backups'),
      force: false,
    });
    return join(skillsDir, oldName);
  }

  it('installs the renamed skill and removes the old copy', () => {
    const ctx = testContext();
    const old = installOldName(ctx, 'social-core');
    runUpdate({ project: true }, { ...ctx, version: '0.2.0' });
    expect(existsSync(old)).toBe(false);
    expect(existsSync(join(ctx.cwd, '.claude/skills/socialkit-social-core/SKILL.md'))).toBe(true);
    expect(ctx.stdout.join('\n')).toMatch(/renamed\s+social-core -> socialkit-social-core/);
  });

  it('moves an edited old copy to the backup folder instead of deleting it', () => {
    const ctx = testContext();
    const old = installOldName(ctx, 'x-post');
    appendFileSync(join(old, 'SKILL.md'), '\nmy notes\n');
    runUpdate({ project: true }, { ...ctx, version: '0.2.0' });
    expect(existsSync(old)).toBe(false);
    const line = ctx.stdout.find((l) => l.includes('renamed   x-post')) ?? '';
    const backup = /your edited copy: (.+)\)/.exec(line)?.[1] ?? '';
    expect(readFileSync(join(backup, 'SKILL.md'), 'utf8')).toContain('my notes');
  });
});

describe('update', () => {
  it('re-copies clean installs from an older version and skips modified ones', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-youtube-script'] }, ctx);
    appendFileSync(join(ctx.cwd, '.claude/skills/socialkit-youtube-script/SKILL.md'), '\nlocal\n');

    const newer = { ...ctx, version: '0.2.0' };
    const outcomes = runUpdate({ project: true }, newer);
    const byName = Object.fromEntries(outcomes.map((o) => [o.skill, o.action]));
    expect(byName).toEqual({ 'socialkit-social-core': 'updated', 'socialkit-youtube-script': 'skipped' });
  });
});

describe('uninstall', () => {
  it('removes clean skills and keeps modified ones unless forced', async () => {
    const ctx = testContext();
    await runInstall({ project: true, agent: ['claude-code'], skill: ['socialkit-youtube-script'] }, ctx);
    appendFileSync(join(ctx.cwd, '.claude/skills/socialkit-youtube-script/SKILL.md'), '\nlocal\n');

    const first = await runUninstall({ project: true, agent: ['claude-code'] }, ctx);
    expect(first.filter((o) => o.action !== 'absent').map((o) => [o.skill, o.action])).toEqual([
      ['socialkit-social-core', 'removed'],
      ['socialkit-youtube-script', 'skipped'],
    ]);

    const forced = await runUninstall({ project: true, agent: ['claude-code'], force: true }, ctx);
    const script = forced.find((o) => o.skill === 'socialkit-youtube-script');
    expect(script?.action).toBe('removed');
    expect(existsSync(join(script?.backup as string, 'SKILL.md'))).toBe(true);
    expect(existsSync(join(ctx.cwd, '.claude/skills/socialkit-youtube-script'))).toBe(false);
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
    await runInstall({ project: true, agent: ['cursor'], skill: ['socialkit-social-core'] }, ctx);
    runList(ctx);
    expect(ctx.stdout.join('\n')).toMatch(/socialkit-youtube-upload/);
    expect(findInstalled(ctx, ['project'])).toEqual([
      expect.objectContaining({ skill: 'socialkit-social-core', state: 'clean', version: '0.1.0' }),
    ]);
  });
});

describe('findInstalled from the home directory', () => {
  it('reports each install once when project and global roots coincide', async () => {
    const base = testContext();
    const ctx = { ...base, cwd: base.home };
    await runInstall({ global: true, agent: ['claude-code'], skill: ['socialkit-social-core'] }, ctx);
    expect(findInstalled(ctx, ['project', 'global'])).toHaveLength(1);
  });
});

describe('withDependencies', () => {
  it('expands transitively and rejects unknown skills', () => {
    const all = bundledSkills(join(import.meta.dirname, '..', 'skills'));
    expect(withDependencies(['socialkit-youtube-pipeline'], all).map((s) => s.name)).toEqual(
      ALL.filter((name) => name === 'socialkit-social-core' || name.startsWith('socialkit-youtube-')),
    );
    expect(withDependencies(['socialkit-whatsapp-broadcast'], all).map((s) => s.name)).toEqual([
      'socialkit-social-core',
      'socialkit-whatsapp-broadcast',
      'socialkit-whatsapp-templates',
    ]);
    expect(() => withDependencies(['nope'], all)).toThrow(/Unknown skill "nope"/);
  });
});
