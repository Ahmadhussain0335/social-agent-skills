import { Command } from 'commander';
import { AGENTS } from './agents';
import { defaultContext } from './commands/context';
import { runDoctor } from './commands/doctor';
import { runInstall } from './commands/install';
import { runList } from './commands/list';
import { runUninstall } from './commands/uninstall';
import { runUpdate } from './commands/update';
import { formatError } from './shared/errors';

const ctx = defaultContext();
const agentIds = AGENTS.map((a) => a.id).join(', ');

const program = new Command()
  .name('social-skills')
  .description('Install and manage social media Agent Skills for coding agents.')
  .version(ctx.version);

const targetFlags = (cmd: Command) =>
  cmd
    .option('--project', 'use skill directories in the current project')
    .option('--global', 'use skill directories in your home directory')
    .option('--agent <id...>', `target agents (${agentIds}); default: ask, from detected agents`)
    .option('--yes', 'non-interactive: use detected agents and project scope unless --global');

targetFlags(
  program
    .command('install')
    .description("copy skills into each selected agent's skills directory")
    .option('--skill <name...>', 'only these skills (dependencies such as social-core are added)')
    .option('--force', 'replace skills you modified locally (your copy is backed up first)'),
).action(async (opts) => {
  await runInstall(opts, ctx);
});

targetFlags(
  program
    .command('uninstall')
    .description('remove skills installed by this package')
    .option('--skill <name...>', 'only these skills')
    .option('--force', 'also remove skills you modified locally (moved to a backup, not deleted)'),
).action(async (opts) => {
  await runUninstall(opts, ctx);
});

program
  .command('list')
  .description('show bundled skills and where they are installed')
  .action(() => runList(ctx));

program
  .command('update')
  .description('re-copy installed skills from this package version')
  .option('--project', 'only the current project')
  .option('--global', 'only your home directory')
  .option('--force', 'replace skills you modified locally (your copy is backed up first)')
  .action((opts) => {
    runUpdate(opts, ctx);
  });

program
  .command('doctor')
  .description('check Node.js, FFmpeg, credentials and installed skills')
  .action(() => {
    const checks = runDoctor(ctx);
    if (checks.some((c) => c.status === 'fail')) process.exitCode = 1;
  });

program.parseAsync().catch((error: unknown) => {
  process.stderr.write(`${formatError(error)}\n`);
  process.exitCode = 1;
});
