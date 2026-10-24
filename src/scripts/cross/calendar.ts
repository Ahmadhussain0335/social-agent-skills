import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { postPlatform } from '../../platforms/all-posting';
import { type EntryReport, entryDir, inspectEntry, readCalendar } from '../../platforms/calendar';
import { loadState, saveState } from '../../shared/approval';
import { formatError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { POST_FILE, type PostDraft } from '../../shared/post-project';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/calendar.mjs <--status|--publish-due> --file <calendar.json> [--dry-run]

Plans and publishes posts across platforms from one calendar file. Each entry points at a
post folder (post.json + media) and a publish time. Nothing is published unless that
folder's post was approved by the user (social-core post.mjs --approve) and is unchanged.

calendar.json:
  {
    "timezone": "Asia/Karachi",
    "entries": [
      { "dir": "posts/fb-launch", "publishAt": "2026-11-02T10:00:00+05:00", "note": "launch" }
    ]
  }

Actions:
  --status        report each entry: invalid, needs-approval, scheduled, due or published
  --publish-due   publish every approved entry whose time has come, oldest first;
                  run it periodically (for example every 15 minutes from cron)
  --dry-run       with --publish-due: show what would be published, publish nothing

Entries are published one at a time; a failure on one entry does not stop the others.
`;

runScript(
  HELP,
  {
    file: { type: 'string' },
    status: { type: 'boolean' },
    'publish-due': { type: 'boolean' },
    'dry-run': { type: 'boolean' },
  },
  async (flags) => {
    const path = resolve(requireFlag(flags, 'file'));
    const calendar = readCalendar(path);
    const entries = [...calendar.entries].sort((a, b) => Date.parse(a.publishAt) - Date.parse(b.publishAt));
    const reports: EntryReport[] = [];
    for (const entry of entries) reports.push(await inspectEntry(path, entry));

    if (!flags['publish-due']) {
      const counts: Record<string, number> = {};
      for (const r of reports) counts[r.status] = (counts[r.status] ?? 0) + 1;
      printJson({ calendar: path, timezone: calendar.timezone, counts, entries: reports });
      return;
    }

    const results: Array<Record<string, unknown>> = [];
    for (const [i, report] of reports.entries()) {
      if (report.status !== 'due') continue;
      const entry = entries[i] as (typeof entries)[number];
      if (flags['dry-run']) {
        results.push({ dir: report.dir, platform: report.platform, wouldPublish: true });
        continue;
      }
      const dir = entryDir(path, entry);
      try {
        const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;
        const result = await postPlatform(draft.platform).publish(dir, draft, process.env);
        const state = loadState(dir);
        state.history.push({ at: new Date().toISOString(), event: 'published', detail: String(result.id ?? '') });
        saveState(dir, state);
        results.push({ dir: report.dir, platform: report.platform, ok: true, ...result });
        log.info(`published ${report.platform} ${report.dir}`);
      } catch (error) {
        results.push({ dir: report.dir, platform: report.platform, ok: false, error: formatError(error) });
        log.error(`failed ${report.platform} ${report.dir}: ${formatError(error)}`);
      }
    }
    const skipped = reports.filter((r) => r.status === 'needs-approval' || r.status === 'invalid');
    printJson({ published: results, notReady: skipped });
    if (results.some((r) => r.ok === false)) process.exitCode = 1;
  },
);
