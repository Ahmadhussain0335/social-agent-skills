import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AGENTS, detectAgents, getAgent, resolveTargets } from '../src/agents';

describe('resolveTargets', () => {
  it('uses only .claude/skills for Claude Code', () => {
    expect(resolveTargets(['claude-code'], 'project')).toEqual({
      targets: [{ dir: '.claude/skills', agents: ['claude-code'] }],
      duplicates: [],
    });
  });

  it('writes .agents/skills once for codex, gemini, copilot and cursor', () => {
    const plan = resolveTargets(['codex', 'gemini-cli', 'github-copilot', 'cursor'], 'global');
    expect(plan.targets).toEqual([
      { dir: '.agents/skills', agents: ['codex', 'gemini-cli', 'github-copilot', 'cursor'] },
    ]);
    expect(plan.duplicates).toEqual([]);
  });

  it('covers Claude Code and Cursor in a project with .claude/skills alone', () => {
    const plan = resolveTargets(['claude-code', 'cursor'], 'project');
    expect(plan.targets.map((t) => t.dir)).toEqual(['.claude/skills']);
    expect(plan.duplicates).toEqual([]);
  });

  it('needs two directories for Claude Code plus Codex and flags Cursor duplicates', () => {
    const plan = resolveTargets(['claude-code', 'codex', 'cursor'], 'project');
    expect(plan.targets.map((t) => t.dir).sort()).toEqual(['.agents/skills', '.claude/skills']);
    expect(plan.duplicates).toEqual(['cursor']);
  });

  it('does not assume Copilot reads ~/.claude/skills globally', () => {
    const plan = resolveTargets(['claude-code', 'github-copilot'], 'global');
    expect(plan.targets.map((t) => t.dir).sort()).toEqual(['.agents/skills', '.claude/skills']);
    expect(plan.duplicates).toEqual([]);
  });

  it('ignores repeated agent ids', () => {
    expect(resolveTargets(['codex', 'codex'], 'project').targets).toHaveLength(1);
  });

  it('every agent can be covered in both scopes', () => {
    for (const agent of AGENTS) {
      for (const scope of ['project', 'global'] as const) {
        const plan = resolveTargets([agent.id], scope);
        expect(plan.targets).toHaveLength(1);
        expect(agent.reads[scope]).toContain(plan.targets[0]?.dir);
      }
    }
  });
});

describe('detectAgents', () => {
  it('detects by home marker and by binary on PATH', () => {
    const existing = new Set([join('/home/u', '.claude'), join('/bin', 'codex')]);
    const found = detectAgents({ home: '/home/u', pathEnv: '/bin', exists: (p) => existing.has(p) });
    expect(found.map((a) => a.id)).toEqual(['claude-code', 'codex']);
  });

  it('returns nothing when no markers exist', () => {
    expect(detectAgents({ home: '/nowhere', pathEnv: '', exists: () => false })).toEqual([]);
  });
});

describe('getAgent', () => {
  it('rejects unknown ids with the list of known ones', () => {
    expect(() => getAgent('windsurf')).toThrow(/Known agents: claude-code/);
  });
});
