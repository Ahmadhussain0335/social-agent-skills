import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { bundledSkills, withDependencies } from '../core/catalog';
import { type InstallAction, installSkill, type Outcome } from '../core/installer';
import {
  type CliContext,
  chooseAgents,
  chooseScope,
  installContext,
  planTargets,
  scopeRootDir,
  type TargetOptions,
} from './context';

export interface InstallOptions extends TargetOptions {
  skill?: string[];
  force?: boolean;
}

export async function runInstall(opts: InstallOptions, ctx: CliContext): Promise<Outcome<InstallAction>[]> {
  const all = bundledSkills(ctx.skillsRoot);
  const skills = withDependencies(opts.skill?.length ? opts.skill : all.map((s) => s.name), all);
  const scope = await chooseScope(opts, ctx);
  const agents = await chooseAgents(opts, ctx);
  const plan = planTargets(agents, scope, ctx);
  const root = scopeRootDir(scope, ctx);
  const ictx = installContext(ctx, Boolean(opts.force));

  const outcomes: Outcome<InstallAction>[] = [];
  for (const target of plan.targets) {
    const skillsDir = join(root, target.dir);
    mkdirSync(skillsDir, { recursive: true });
    ctx.out(`\n${skillsDir}  (read by ${target.agents.join(', ')})`);
    for (const skill of skills) {
      const outcome = installSkill(skill, skillsDir, ictx);
      outcomes.push(outcome);
      reportInstall(outcome, ctx);
    }
  }
  summarize(outcomes, ctx);
  return outcomes;
}

export function reportInstall(outcome: Outcome<InstallAction>, ctx: CliContext): void {
  ctx.out(`  ${outcome.action.padEnd(9)} ${outcome.skill}`);
  if (outcome.action === 'skipped') {
    ctx.err(`  Skipped ${outcome.skill}: ${outcome.reason}. Re-run with --force to replace it.`);
    if (outcome.diff) ctx.err(indent(outcome.diff));
  }
  if (outcome.action === 'replaced') {
    ctx.err(`  Replaced ${outcome.skill} (${outcome.reason}). Your copy was moved to ${outcome.backup}`);
  }
}

function summarize(outcomes: Outcome<InstallAction>[], ctx: CliContext): void {
  const skipped = outcomes.filter((o) => o.action === 'skipped').length;
  ctx.out(
    `\nDone. ${outcomes.length - skipped} written or up to date${skipped ? `, ${skipped} skipped because of local changes` : ''}.`,
  );
  ctx.out('Run "social-skills doctor" to check credentials and FFmpeg.');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}
