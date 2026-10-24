import type { Scope } from '../agents';
import { bundledSkills } from '../core/catalog';
import { type InstallAction, installSkill, type Outcome } from '../core/installer';
import { type CliContext, installContext } from './context';
import { reportInstall } from './install';
import { findInstalled } from './list';

export interface UpdateOptions {
  project?: boolean;
  global?: boolean;
  force?: boolean;
}

/** Re-copies every installed skill from the current package version. */
export function runUpdate(opts: UpdateOptions, ctx: CliContext): Outcome<InstallAction>[] {
  const scopes: Scope[] =
    opts.project && !opts.global ? ['project'] : opts.global && !opts.project ? ['global'] : ['project', 'global'];
  const bundled = new Map(bundledSkills(ctx.skillsRoot).map((s) => [s.name, s]));
  const ictx = installContext(ctx, Boolean(opts.force));

  const outcomes: Outcome<InstallAction>[] = [];
  for (const item of findInstalled(ctx, scopes)) {
    const source = bundled.get(item.skill);
    if (!source) {
      ctx.err(`  ${item.skill} is no longer part of the package; leaving it in place.`);
      continue;
    }
    const outcome = installSkill(source, item.skillsDir, ictx);
    outcomes.push(outcome);
    reportInstall(outcome, ctx);
  }
  if (outcomes.length === 0) ctx.out('No installed skills found. Run "social-skills install" first.');
  return outcomes;
}
