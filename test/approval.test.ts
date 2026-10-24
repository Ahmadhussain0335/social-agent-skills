import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveCheckpoint, loadState, newState, saveState, verifyCheckpoint } from '../src/shared/approval';
import { fakeTty, tmp, write } from './helpers';

const script = { id: 'script', title: 'Script', requires: [] };
const meta = { id: 'metadata', title: 'Metadata', requires: ['script'] };

function project() {
  const dir = tmp();
  saveState(dir, newState('demo'));
  write(join(dir, 'script.md'), 'draft');
  write(join(dir, 'metadata.json'), '{}');
  return dir;
}

describe('approval checkpoints', () => {
  it('refuses to approve without an interactive terminal', async () => {
    const dir = project();
    await expect(
      approveCheckpoint({ dir, def: script, files: ['script.md'], tty: fakeTty(['approve'], false), summary: '' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_NEEDS_TERMINAL' });
    expect(loadState(dir).checkpoints).toEqual({});
  });

  it('requires the exact word "approve"', async () => {
    const dir = project();
    await expect(
      approveCheckpoint({ dir, def: script, files: ['script.md'], tty: fakeTty(['yes']), summary: '' }),
    ).rejects.toMatchObject({ code: 'APPROVAL_DECLINED' });
  });

  it('binds approval to file hashes', async () => {
    const dir = project();
    const tty = fakeTty(['approve']);
    await approveCheckpoint({ dir, def: script, files: ['script.md'], tty, summary: 'Review this' });
    expect(tty.asked[0]).toContain('Review this');

    expect(await verifyCheckpoint(dir, loadState(dir), 'script', ['script.md'])).toEqual({ ok: true, problems: [] });

    appendFileSync(join(dir, 'script.md'), ' edited');
    const after = await verifyCheckpoint(dir, loadState(dir), 'script', ['script.md']);
    expect(after.ok).toBe(false);
    expect(after.problems).toEqual(['script.md changed after the "script" approval']);
  });

  it('reports files not covered by the approval', async () => {
    const dir = project();
    await approveCheckpoint({ dir, def: script, files: ['script.md'], tty: fakeTty(['approve']), summary: '' });
    const result = await verifyCheckpoint(dir, loadState(dir), 'script', ['script.md', 'metadata.json']);
    expect(result.problems).toEqual(['metadata.json was not part of the "script" approval']);
  });

  it('enforces checkpoint order and invalidates later steps when earlier files change', async () => {
    const dir = project();
    await expect(
      approveCheckpoint({ dir, def: meta, files: ['metadata.json'], tty: fakeTty(['approve']), summary: '' }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_ORDER' });

    await approveCheckpoint({ dir, def: script, files: ['script.md'], tty: fakeTty(['approve']), summary: '' });
    appendFileSync(join(dir, 'script.md'), ' late edit');
    await expect(
      approveCheckpoint({ dir, def: meta, files: ['metadata.json'], tty: fakeTty(['approve']), summary: '' }),
    ).rejects.toMatchObject({ code: 'CHECKPOINT_ORDER' });
  });

  it('records history', async () => {
    const dir = project();
    await approveCheckpoint({ dir, def: script, files: ['script.md'], tty: fakeTty(['approve']), summary: '' });
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state.history.map((h: { event: string }) => h.event)).toEqual(['created', 'approved:script']);
  });
});
