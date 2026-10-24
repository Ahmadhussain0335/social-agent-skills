import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { loadState, verifyCheckpoint } from '../shared/approval';
import { PlatformError } from '../shared/errors';
import { POST_FILE, type PostDraft, PUBLISH_CHECKPOINT, publishFiles } from '../shared/post-project';
import { postPlatform } from './posting';

// A content calendar is a JSON file listing post folders and when each should go out.
// Publishing a due entry still requires that folder's own approval; the calendar never
// approves anything. Platforms with API scheduling can be handed off early (native).

export interface CalendarEntry {
  /** Post folder, relative to the calendar file. */
  dir: string;
  publishAt: string;
  note?: string;
}

export interface CalendarFile {
  timezone?: string;
  entries: CalendarEntry[];
}

export type EntryStatus = 'invalid' | 'needs-approval' | 'scheduled' | 'due' | 'published';

export interface EntryReport {
  dir: string;
  platform: string;
  kind: string;
  publishAt: string;
  status: EntryStatus;
  problems: string[];
}

export function readCalendar(path: string): CalendarFile {
  if (!existsSync(path)) throw new PlatformError('CALENDAR_MISSING', `Calendar file not found: ${path}`);
  const calendar = JSON.parse(readFileSync(path, 'utf8')) as CalendarFile;
  if (!Array.isArray(calendar.entries))
    throw new PlatformError('CALENDAR_FORMAT', 'calendar.json needs an "entries" array.');
  for (const [i, e] of calendar.entries.entries()) {
    if (!e.dir || Number.isNaN(Date.parse(e.publishAt))) {
      throw new PlatformError('CALENDAR_FORMAT', `entries[${i}] needs "dir" and an ISO 8601 "publishAt".`);
    }
  }
  return calendar;
}

export function entryDir(calendarPath: string, entry: CalendarEntry): string {
  return isAbsolute(entry.dir) ? entry.dir : resolve(dirname(calendarPath), entry.dir);
}

export async function inspectEntry(calendarPath: string, entry: CalendarEntry, now = Date.now()): Promise<EntryReport> {
  const dir = entryDir(calendarPath, entry);
  const base = { dir: entry.dir, publishAt: entry.publishAt };
  if (!existsSync(join(dir, POST_FILE))) {
    return { ...base, platform: '?', kind: '?', status: 'invalid', problems: [`${POST_FILE} not found`] };
  }
  const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;
  const report = { ...base, platform: draft.platform, kind: draft.kind };

  if (loadState(dir).history.some((h) => h.event === 'published'))
    return { ...report, status: 'published', problems: [] };

  let check: { ok: boolean; errors: string[] };
  try {
    check = postPlatform(draft.platform).check(draft, now);
  } catch (error) {
    return { ...report, status: 'invalid', problems: [(error as Error).message] };
  }
  if (!check.ok) return { ...report, status: 'invalid', problems: check.errors };

  const approval = await verifyCheckpoint(dir, loadState(dir), PUBLISH_CHECKPOINT.id, publishFiles(dir, draft));
  if (!approval.ok) return { ...report, status: 'needs-approval', problems: approval.problems };
  return { ...report, status: Date.parse(entry.publishAt) <= now ? 'due' : 'scheduled', problems: [] };
}
