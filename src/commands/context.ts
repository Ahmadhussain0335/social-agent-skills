import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  AGENTS,
  type AgentDef,
  type AgentId,
  detectAgents,
  getAgent,
  resolveTargets,
  type Scope,
  type TargetPlan,
} from '../agents';
import { packageInfo } from '../core/catalog';
import type { InstallContext } from '../core/installer';
import { configDir } from '../shared/config-paths';
import { chooseMany, processTty, type Tty } from '../shared/prompt';

export interface CliContext {
  cwd: string;
  home: string;
  env: NodeJS.ProcessEnv;
  tty: Tty;
  out: (line: string) => void;
  err: (line: string) => void;
  skillsRoot: string;
  packageName: string;
  version: string;
}

export function defaultContext(): CliContext {
  const pkg = packageInfo();
  return {
    cwd: process.cwd(),
    home: homedir(),
    env: process.env,
    tty: processTty,
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    skillsRoot: join(pkg.root, 'skills'),
    packageName: pkg.name,
    version: pkg.version,
  };
}

export interface TargetOptions {
  project?: boolean;
  global?: boolean;
  agent?: string[];
  yes?: boolean;
}

export async function chooseScope(opts: TargetOptions, ctx: CliContext): Promise<Scope> {
  if (opts.project && opts.global) throw new Error('Use either --project or --global, not both.');
  if (opts.global) return 'global';
  if (opts.project || opts.yes || !ctx.tty.isInteractive()) return 'project';
  const answer = await ctx.tty.ask(
    `Install into this project (${ctx.cwd}) or globally for your user? [p/g] (default p): `,
  );
  return answer.toLowerCase().startsWith('g') ? 'global' : 'project';
}

export async function chooseAgents(opts: TargetOptions, ctx: CliContext): Promise<AgentDef[]> {
  if (opts.agent && opts.agent.length > 0) return opts.agent.map(getAgent);

  const detected = detectAgents({ home: ctx.home, pathEnv: ctx.env.PATH });
  if (opts.yes) {
    if (detected.length === 0) {
      throw new Error(`No agents detected. Pass --agent with one of: ${AGENTS.map((a) => a.id).join(', ')}`);
    }
    return detected;
  }
  if (!ctx.tty.isInteractive()) {
    throw new Error(
      `No terminal to ask which agents to target. Pass --agent <id> (${AGENTS.map((a) => a.id).join(', ')}) or --yes to use detected agents.`,
    );
  }
  const options = detected.length > 0 ? detected : [...AGENTS];
  const heading =
    detected.length > 0 ? 'Detected agents. Which should get the skills?' : 'No agents detected. Pick agents:';
  const picked = await chooseMany(ctx.tty, heading, options, (a) => `${a.label} (${a.id})`);
  if (picked.length === 0) throw new Error('No agents selected.');
  return picked;
}

export function planTargets(agents: readonly AgentDef[], scope: Scope, ctx: CliContext): TargetPlan {
  const plan = resolveTargets(
    agents.map((a) => a.id as AgentId),
    scope,
  );
  if (plan.duplicates.length > 0) {
    ctx.err(
      `Note: ${plan.duplicates.join(', ')} read more than one of the target directories and may list each skill twice.`,
    );
  }
  return plan;
}

export function scopeRootDir(scope: Scope, ctx: CliContext): string {
  return scope === 'global' ? ctx.home : ctx.cwd;
}

export function installContext(ctx: CliContext, force: boolean): InstallContext {
  return {
    packageName: ctx.packageName,
    version: ctx.version,
    backupRoot: join(configDir(ctx.env), 'backups'),
    force,
  };
}

/** Every skill directory any supported agent reads, for list/update scans. */
export function allKnownDirs(scope: Scope): string[] {
  return [...new Set(AGENTS.flatMap((a) => a.reads[scope]))];
}
