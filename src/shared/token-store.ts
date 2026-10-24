import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PlatformError } from './errors';

/** Returns the git work tree containing path, if any. Tokens must never live inside one. */
export function findGitRoot(path: string): string | undefined {
  let dir = resolve(path);
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Writes JSON atomically with mode 0600 in a 0700 directory. */
export function writeSecretJson(path: string, value: unknown): void {
  const target = resolve(path);
  const repo = findGitRoot(dirname(target));
  if (repo) {
    throw new PlatformError(
      'TOKEN_PATH_IN_REPO',
      `Refusing to store credentials inside the git repository at ${repo}.`,
      'Point the token path at your user config directory (the default) instead of a project folder.',
    );
  }
  mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, target);
  if (process.platform !== 'win32') chmodSync(target, 0o600);
}

export function readSecretJson<T>(path: string): T | undefined {
  if (!existsSync(path)) return undefined;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

/** True when group or others can read the file. Always false on Windows, where modes do not apply. */
export function isTooOpen(path: string): boolean {
  if (process.platform === 'win32') return false;
  return (statSync(path).mode & 0o077) !== 0;
}
