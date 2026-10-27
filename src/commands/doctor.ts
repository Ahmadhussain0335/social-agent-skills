import { PLATFORMS } from '../platforms';
import { FFMPEG_MISSING_HINT, resolveFfmpeg } from '../shared/ffmpeg';
import type { Check } from '../shared/platform';
import type { CliContext } from './context';
import { findInstalled } from './list';

const MIN_NODE = [22, 12] as const;

export function nodeCheck(version = process.versions.node): Check {
  const [major = 0, minor = 0] = version.split('.').map(Number);
  const ok = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return {
    name: 'Node.js',
    status: ok ? 'ok' : 'fail',
    detail: ok ? `v${version}` : `v${version}; need ${MIN_NODE.join('.')} or newer`,
  };
}

export function runDoctor(ctx: CliContext): Check[] {
  const checks: Check[] = [nodeCheck()];

  const ffmpeg = resolveFfmpeg(ctx.env);
  checks.push(
    ffmpeg
      ? { name: 'FFmpeg', status: 'ok', detail: `${ffmpeg.path} (from ${ffmpeg.source})` }
      : {
          name: 'FFmpeg',
          status: 'fail',
          detail: `no working ffmpeg found (needed for socialkit-youtube-assemble). ${FFMPEG_MISSING_HINT}`,
        },
  );

  for (const platform of PLATFORMS) checks.push(...platform.doctor(ctx.env));

  const installed = findInstalled(ctx, ['project', 'global']);
  const modified = installed.filter((i) => i.state === 'modified').length;
  const stale = installed.filter((i) => i.version !== ctx.version).length;
  checks.push({
    name: 'Installed skills',
    status: installed.length === 0 ? 'warn' : stale > 0 ? 'warn' : 'ok',
    detail:
      installed.length === 0
        ? 'none found; run "social-skills install"'
        : `${installed.length} installed${modified ? `, ${modified} modified locally` : ''}${stale ? `, ${stale} older than ${ctx.version} (run "social-skills update")` : ''}`,
  });

  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    ctx.out(`${check.status.toUpperCase().padEnd(4)}  ${check.name.padEnd(width)}  ${check.detail}`);
  }
  return checks;
}
