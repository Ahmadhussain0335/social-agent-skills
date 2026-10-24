import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { postPlatform } from '../../platforms/all-posting';
import { findPublished } from '../../platforms/published';
import { youtubeMetrics } from '../../platforms/youtube/engagement';
import { formatError } from '../../shared/errors';
import { printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/analytics.mjs --root <folder> [--out <folder>]

Collects engagement metrics for everything published from post folders and YouTube
projects under --root, and writes report.json and report.md. Read-only.

Metrics are reported as each platform names them (views, likes, comments, shares,
reactions, ...). Platforms count differently, so the report does not combine them into
one engagement score.

Requirements: YouTube needs YT_API_KEY. Instagram insights and Threads metrics need the
meta-auth sign-in with --with-engagement. Platforms without a metrics API are listed as such.
`;

runScript(HELP, { root: { type: 'string' }, out: { type: 'string' } }, async (flags) => {
  const root = resolve(requireFlag(flags, 'root'));
  const out = resolve((flags.out as string | undefined) ?? root);
  const rows: Array<Record<string, unknown>> = [];

  for (const item of findPublished(root)) {
    try {
      let metrics: Record<string, number> | undefined;
      if (item.platform === 'youtube') metrics = await youtubeMetrics(item.postId);
      else metrics = await postPlatform(item.platform).metrics?.(item.postId, process.env);
      rows.push({ ...item, metrics: metrics ?? null, note: metrics ? undefined : 'no metrics API for this platform' });
    } catch (error) {
      rows.push({ ...item, metrics: null, error: formatError(error) });
    }
  }

  const generatedAt = new Date().toISOString();
  writeFileSync(join(out, 'report.json'), `${JSON.stringify({ generatedAt, root, rows }, null, 2)}\n`);
  const lines = [
    `# Social analytics`,
    '',
    `Generated ${generatedAt} for \`${root}\`.`,
    '',
    '| Published | Platform | Folder | Post | Metrics |',
    '| - | - | - | - | - |',
    ...rows.map((r) => {
      const m = r.metrics as Record<string, number> | null;
      const metrics = m
        ? Object.entries(m)
            .map(([k, v]) => `${k} ${v}`)
            .join(', ')
        : ((r.error as string) ?? (r.note as string) ?? '');
      return `| ${String(r.publishedAt).slice(0, 10)} | ${r.platform} | ${r.folder} | ${r.postId} | ${metrics.replace(/\|/g, '/').replace(/\n/g, ' ')} |`;
    }),
  ];
  writeFileSync(join(out, 'report.md'), `${lines.join('\n')}\n`);
  printJson({ ok: true, items: rows.length, report: join(out, 'report.md') });
});
