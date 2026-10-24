import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import '../src/platforms/all-posting';
import { inspectEntry, readCalendar } from '../src/platforms/calendar';
import { postPlatform, postPlatforms, registerPostPlatform } from '../src/platforms/posting';
import { approveCheckpoint, loadState, newState, saveState } from '../src/shared/approval';
import { type PostDraft, PUBLISH_CHECKPOINT, publishFiles } from '../src/shared/post-project';
import { fakeTty, tmp, write } from './helpers';

registerPostPlatform({
  id: 'testnet',
  label: 'Test network',
  kinds: ['text'],
  textLimit: 10,
  scheduling: false,
  notes: [],
  check: (d) => ({
    ok: (d.text ?? '').length <= 10,
    errors: (d.text ?? '').length > 10 ? ['too long'] : [],
    warnings: [],
  }),
  publish: async () => ({ id: 'x1' }),
});

async function folder(root: string, name: string, draft: PostDraft, approve: boolean) {
  const dir = join(root, name);
  saveState(dir, newState(name));
  write(join(dir, 'post.json'), JSON.stringify(draft));
  if (approve) {
    await approveCheckpoint({
      dir,
      def: PUBLISH_CHECKPOINT,
      files: publishFiles(dir, draft),
      tty: fakeTty(['approve']),
      summary: '',
    });
  }
  return dir;
}

describe('posting registry', () => {
  it('registers the Meta platforms', () => {
    expect(postPlatforms().map((p) => p.id)).toEqual(expect.arrayContaining(['facebook', 'instagram', 'threads']));
    expect(postPlatform('instagram').scheduling).toBe(false);
    expect(() => postPlatform('myspace')).toThrow(/Unknown posting platform/);
  });
});

describe('calendar', () => {
  const now = Date.parse('2026-11-02T06:00:00Z');

  it('reports invalid, needs-approval, scheduled, due and published entries', async () => {
    const root = tmp();
    await folder(root, 'bad', { platform: 'testnet', kind: 'text', text: 'x'.repeat(11) }, false);
    await folder(root, 'unapproved', { platform: 'testnet', kind: 'text', text: 'hi' }, false);
    await folder(root, 'later', { platform: 'testnet', kind: 'text', text: 'hi' }, true);
    await folder(root, 'due', { platform: 'testnet', kind: 'text', text: 'hi' }, true);
    const doneDir = await folder(root, 'done', { platform: 'testnet', kind: 'text', text: 'hi' }, true);
    const state = loadState(doneDir);
    state.history.push({ at: '2026-11-01T00:00:00Z', event: 'published', detail: 'x0' });
    saveState(doneDir, state);

    const calendarPath = join(root, 'calendar.json');
    writeFileSync(
      calendarPath,
      JSON.stringify({
        entries: [
          { dir: 'bad', publishAt: '2026-11-01T00:00:00Z' },
          { dir: 'unapproved', publishAt: '2026-11-01T00:00:00Z' },
          { dir: 'later', publishAt: '2026-11-03T00:00:00Z' },
          { dir: 'due', publishAt: '2026-11-02T05:00:00Z' },
          { dir: 'done', publishAt: '2026-11-01T00:00:00Z' },
          { dir: 'missing', publishAt: '2026-11-01T00:00:00Z' },
        ],
      }),
    );
    const calendar = readCalendar(calendarPath);
    const statuses = [];
    for (const entry of calendar.entries) statuses.push((await inspectEntry(calendarPath, entry, now)).status);
    expect(statuses).toEqual(['invalid', 'needs-approval', 'scheduled', 'due', 'published', 'invalid']);
  });

  it('treats a post edited after approval as needing approval again', async () => {
    const root = tmp();
    const dir = await folder(root, 'p', { platform: 'testnet', kind: 'text', text: 'hi' }, true);
    appendFileSync(join(dir, 'post.json'), ' ');
    const report = await inspectEntry(join(root, 'c.json'), { dir: 'p', publishAt: '2026-11-01T00:00:00Z' }, now);
    expect(report.status).toBe('needs-approval');
    expect(report.problems[0]).toMatch(/post.json changed/);
  });

  it('rejects malformed calendars', () => {
    const path = join(tmp(), 'c.json');
    writeFileSync(path, JSON.stringify({ entries: [{ dir: 'a', publishAt: 'tomorrow' }] }));
    expect(() => readCalendar(path)).toThrow(/ISO 8601/);
  });
});

describe('findPublished', () => {
  it('finds published posts and uploaded YouTube videos from state history', async () => {
    const { findPublished } = await import('../src/platforms/published');
    const root = tmp();
    const post = join(root, 'posts', 'th-1');
    saveState(post, newState('th-1'));
    write(join(post, 'post.json'), JSON.stringify({ platform: 'threads', kind: 'text', text: 'hi' }));
    const s = loadState(post);
    s.history.push({ at: '2026-10-20T00:00:00Z', event: 'published', detail: 'th123' });
    saveState(post, s);

    const yt = join(root, 'yt-demo');
    saveState(yt, newState('yt'));
    const y = loadState(yt);
    y.history.push({ at: '2026-10-21T00:00:00Z', event: 'uploaded', detail: 'vid42 abcdef' });
    saveState(yt, y);

    saveState(join(root, 'draft-only'), newState('draft'));
    expect(findPublished(root).map((i) => [i.platform, i.postId, i.folder])).toEqual([
      ['threads', 'th123', join('posts', 'th-1')],
      ['youtube', 'vid42', 'yt-demo'],
    ]);
  });
});
