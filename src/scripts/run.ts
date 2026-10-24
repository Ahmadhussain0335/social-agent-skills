import { type ParseArgsConfig, parseArgs } from 'node:util';
import { formatError } from '../shared/errors';
import { redact } from '../shared/log';

export type Flags = Record<string, string | boolean | undefined>;

/** Shared entry for skill scripts: --help, strict flag parsing, redacted errors, exit codes. */
export function runScript(
  help: string,
  options: NonNullable<ParseArgsConfig['options']>,
  main: (flags: Flags) => Promise<void> | void,
): void {
  let flags: Flags;
  try {
    flags = parseArgs({
      options: { ...options, help: { type: 'boolean', short: 'h' } },
      strict: true,
      allowPositionals: false,
    }).values as Flags;
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${help.trim()}\n`);
    process.exit(2);
  }
  if (flags.help) {
    process.stdout.write(`${help.trim()}\n`);
    return;
  }
  Promise.resolve()
    .then(() => main(flags))
    .catch((error: unknown) => {
      process.stderr.write(`${redact(formatError(error))}\n`);
      process.exitCode = 1;
    });
}

export function requireFlag(flags: Flags, name: string): string {
  const value = flags[name];
  if (typeof value !== 'string' || value.length === 0) {
    process.stderr.write(`Missing required --${name}. Run with --help for usage.\n`);
    process.exit(2);
  }
  return value;
}
