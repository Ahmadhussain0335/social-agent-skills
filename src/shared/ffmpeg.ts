import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, join } from 'node:path';

export interface FfmpegLocation {
  path: string;
  source: 'FFMPEG_PATH' | 'ffmpeg-static' | 'PATH';
}

/**
 * Lookup order: FFMPEG_PATH, then ffmpeg-static next to this file or in the global npm
 * install of the package, then ffmpeg on PATH. Skill scripts are copied out of node_modules,
 * so the bundled ffmpeg-static binary is only reachable when the package is installed globally.
 */
export function resolveFfmpeg(env: NodeJS.ProcessEnv = process.env): FfmpegLocation | undefined {
  const fromEnv = env.FFMPEG_PATH;
  if (fromEnv && isUsable(fromEnv)) return { path: fromEnv, source: 'FFMPEG_PATH' };

  const fromPackage = ffmpegStaticPath();
  if (fromPackage) return { path: fromPackage, source: 'ffmpeg-static' };

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, exe);
    if (isUsable(candidate)) return { path: candidate, source: 'PATH' };
  }
  return undefined;
}

// An interrupted ffmpeg-static download leaves a truncated, non-executable file that its
// installer then reports as "installed already", so existence alone is not enough.
export function isUsable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    return false;
  }
  const result = spawnSync(path, ['-version'], { stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  return result.status === 0 && result.stdout.toString().startsWith('ffmpeg version');
}

function ffmpegStaticPath(): string | undefined {
  const bases = [import.meta.url];
  const globalRoot = npmGlobalRoot();
  if (globalRoot) {
    bases.push(join(globalRoot, '@ahmadhussain0335', 'social-skills', 'package.json'));
    bases.push(join(globalRoot, 'package.json'));
  }
  for (const base of bases) {
    try {
      const path = createRequire(base)('ffmpeg-static') as string | null;
      if (path && isUsable(path)) return path;
    } catch {
      // not resolvable from this base
    }
  }
  return undefined;
}

function npmGlobalRoot(): string | undefined {
  try {
    return execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 10_000,
      shell: process.platform === 'win32',
    }).trim();
  } catch {
    return undefined;
  }
}

export const FFMPEG_MISSING_HINT =
  'Install FFmpeg, set FFMPEG_PATH to an ffmpeg binary, or run "npm install -g @ahmadhussain0335/social-skills" to get the bundled ffmpeg-static binary. If ffmpeg-static is already installed, its download may be incomplete: delete its ffmpeg file and run "npm rebuild ffmpeg-static".';
