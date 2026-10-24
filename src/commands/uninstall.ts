import { join } from 'node:path';
import { bundledSkills } from '../core/catalog';
import { type Outcome, type UninstallAction, uninstallSkill } from '../core/installer';
import { NAME_PATTERN } from '../core/skill-validator';
import {
  type CliContext,
  chooseAgents,
  chooseScope,
  installContext,
  planTargets,
  scopeRootDir,
  type TargetOptions,
} from './context';

export interface UninstallOptions extends TargetOptions {
  skill?: string[];
  force?: boolean;
}

export async function runUninstall(opts: UninstallOptions, ctx: CliContext): Promise<Outcome<UninstallAction>[]> {
  const names = opts.skill?.length ? opts.skill : bundledSkills(ctx.skillsRoot).map((s) => s.name);
  // Names become path segments; only spec-valid skill names, never "../" or separators.
  const invalid = names.filter((name) => !NAME_PATTERN.test(name));
  if (invalid.length > 0) throw new Error(`Invalid skill name: ${invalid.join(', ')}`);
  const scope = await chooseScope(opts, ctx);
  const agents = await chooseAgents(opts, ctx);
  const plan = planTargets(agents, scope, ctx);
  const root = scopeRootDir(scope, ctx);
  const ictx = installContext(ctx, Boolean(opts.force));

  const outcomes: Outcome<UninstallAction>[] = [];
  for (const target of plan.targets) {
    const skillsDir = join(root, target.dir);
    for (const name of names) {
      const outcome = uninstallSkill(name, skillsDir, ictx);
      outcomes.push(outcome);
      if (outcome.action === 'absent') continue;
      ctx.out(`  ${outcome.action.padEnd(8)} ${join(target.dir, name)}`);
      if (outcome.action === 'skipped') {
        ctx.err(`  Kept ${outcome.skill}: ${outcome.reason}. Re-run with --force to remove it (a backup is kept).`);
      } else if (outcome.backup) {
        ctx.err(`  Your modified copy was moved to ${outcome.backup}`);
      }
    }
  }
  if (outcomes.every((o) => o.action === 'absent')) ctx.out('Nothing to uninstall.');
  return outcomes;
}
