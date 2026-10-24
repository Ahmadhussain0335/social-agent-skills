import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

// Skill directories each agent reads, taken from the official docs (checked 2026-10-23):
// - Claude Code:    https://code.claude.com/docs/en/skills
//                   project .claude/skills, personal ~/.claude/skills
// - OpenAI Codex:   https://learn.chatgpt.com/docs/build-skills
//                   (redirect target of https://developers.openai.com/codex/skills)
//                   repo .agents/skills (cwd up to repo root), user ~/.agents/skills
// - Gemini CLI:     https://geminicli.com/docs/cli/skills/
//                   workspace .gemini/skills or .agents/skills alias, user ~/.gemini/skills or ~/.agents/skills
// - GitHub Copilot: https://docs.github.com/en/copilot/concepts/agents/about-agent-skills
//                   project .github/skills, .claude/skills or .agents/skills; personal ~/.copilot/skills or ~/.agents/skills
// - Cursor:         https://cursor.com/docs/context/skills
//                   project .agents/skills or .cursor/skills, user ~/.agents/skills or ~/.cursor/skills,
//                   plus compatibility dirs .claude/skills, .codex/skills (project and user)

export type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'github-copilot' | 'cursor';
export type Scope = 'project' | 'global';

export interface AgentDef {
  id: AgentId;
  label: string;
  docs: string;
  /** Skill directories the agent reads, relative to the project root or the home directory. */
  reads: Record<Scope, readonly string[]>;
  /** Home-relative paths whose presence suggests the agent is installed. */
  homeMarkers: readonly string[];
  /** Executables whose presence on PATH suggests the agent is installed. */
  bins: readonly string[];
}

export const AGENTS: readonly AgentDef[] = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    docs: 'https://code.claude.com/docs/en/skills',
    reads: { project: ['.claude/skills'], global: ['.claude/skills'] },
    homeMarkers: ['.claude'],
    bins: ['claude'],
  },
  {
    id: 'codex',
    label: 'OpenAI Codex',
    docs: 'https://learn.chatgpt.com/docs/build-skills',
    reads: { project: ['.agents/skills'], global: ['.agents/skills'] },
    homeMarkers: ['.codex'],
    bins: ['codex'],
  },
  {
    id: 'gemini-cli',
    label: 'Gemini CLI',
    docs: 'https://geminicli.com/docs/cli/skills/',
    reads: {
      project: ['.agents/skills', '.gemini/skills'],
      global: ['.agents/skills', '.gemini/skills'],
    },
    homeMarkers: ['.gemini'],
    bins: ['gemini'],
  },
  {
    id: 'github-copilot',
    label: 'GitHub Copilot',
    docs: 'https://docs.github.com/en/copilot/concepts/agents/about-agent-skills',
    reads: {
      project: ['.agents/skills', '.github/skills', '.claude/skills'],
      global: ['.agents/skills', '.copilot/skills'],
    },
    homeMarkers: ['.copilot'],
    bins: ['copilot'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    docs: 'https://cursor.com/docs/context/skills',
    reads: {
      project: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'],
      global: ['.agents/skills', '.cursor/skills', '.claude/skills', '.codex/skills'],
    },
    homeMarkers: ['.cursor'],
    bins: ['cursor', 'cursor-agent'],
  },
];

// Tie-break order when two directories cover the same number of agents.
// .claude/skills first so Claude Code users get a single copy where possible,
// then the cross-agent .agents/skills directory.
const DIR_PRIORITY = [
  '.claude/skills',
  '.agents/skills',
  '.gemini/skills',
  '.copilot/skills',
  '.cursor/skills',
  '.github/skills',
  '.codex/skills',
];

export function getAgent(id: string): AgentDef {
  const agent = AGENTS.find((a) => a.id === id);
  if (!agent) {
    throw new Error(`Unknown agent "${id}". Known agents: ${AGENTS.map((a) => a.id).join(', ')}`);
  }
  return agent;
}

export interface DetectOptions {
  home?: string;
  pathEnv?: string;
  exists?: (path: string) => boolean;
}

export function detectAgents(opts: DetectOptions = {}): AgentDef[] {
  const home = opts.home ?? homedir();
  const exists = opts.exists ?? existsSync;
  const pathDirs = (opts.pathEnv ?? process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const onPath = (bin: string) => pathDirs.some((dir) => exts.some((ext) => exists(join(dir, bin + ext))));

  return AGENTS.filter(
    (agent) => agent.homeMarkers.some((marker) => exists(join(home, marker))) || agent.bins.some(onPath),
  );
}

export interface InstallTarget {
  /** Directory relative to the scope root, e.g. ".agents/skills". */
  dir: string;
  /** Selected agents that read this directory. */
  agents: AgentId[];
}

export interface TargetPlan {
  targets: InstallTarget[];
  /** Agents that will see the same skill in more than one selected directory. */
  duplicates: AgentId[];
}

/**
 * Picks the smallest set of skill directories that every selected agent reads,
 * so shared directories like .agents/skills are written once instead of per agent.
 */
export function resolveTargets(agentIds: readonly AgentId[], scope: Scope): TargetPlan {
  const agents = [...new Set(agentIds)].map(getAgent);
  const uncovered = new Set(agents.map((a) => a.id));
  const chosen: string[] = [];

  while (uncovered.size > 0) {
    const candidates = new Map<string, number>();
    for (const agent of agents) {
      if (!uncovered.has(agent.id)) continue;
      for (const dir of agent.reads[scope]) {
        candidates.set(dir, (candidates.get(dir) ?? 0) + 1);
      }
    }
    const best = [...candidates.entries()].sort((a, b) => b[1] - a[1] || priority(a[0]) - priority(b[0]))[0];
    if (!best) break;
    chosen.push(best[0]);
    for (const agent of agents) {
      if (agent.reads[scope].includes(best[0])) uncovered.delete(agent.id);
    }
  }

  const targets = chosen.map((dir) => ({
    dir,
    agents: agents.filter((a) => a.reads[scope].includes(dir)).map((a) => a.id),
  }));
  const duplicates = agents
    .filter((a) => chosen.filter((dir) => a.reads[scope].includes(dir)).length > 1)
    .map((a) => a.id);

  return { targets, duplicates };
}

function priority(dir: string): number {
  const index = DIR_PRIORITY.indexOf(dir);
  return index === -1 ? DIR_PRIORITY.length : index;
}

export function scopeRoot(scope: Scope, opts: { cwd?: string; home?: string } = {}): string {
  return scope === 'global' ? (opts.home ?? homedir()) : (opts.cwd ?? process.cwd());
}
