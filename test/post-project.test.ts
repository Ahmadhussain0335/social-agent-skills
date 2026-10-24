import { appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { approveCheckpoint, newState, saveState } from '../src/shared/approval';
import {
  localMediaPaths,
  type PostDraft,
  PUBLISH_CHECKPOINT,
  publishFiles,
  requirePublishApproval,
} from '../src/shared/post-project';
import { fakeTty, tmp, write } from './helpers';

const draft: PostDraft = {
  platform: 'instagram',
  kind: 'feed',
  text: 'Hello',
  media: [
    { source: 'img/a.jpg', type: 'image' },
    { source: 'https://cdn.example.com/b.jpg', type: 'image' },
  ],
};

function folder() {
  const dir = tmp();
  saveState(dir, newState('post'));
  write(join(dir, 'post.json'), JSON.stringify(draft));
  write(join(dir, 'img/a.jpg'), 'jpeg');
  return dir;
}

describe('post project', () => {
  it('covers post.json and local media, not remote URLs', () => {
    expect(publishFiles(folder(), draft)).toEqual(['post.json', 'img/a.jpg']);
  });

  it('rejects media paths outside the folder', () => {
    expect(() => localMediaPaths({ ...draft, media: [{ source: '../secret.jpg', type: 'image' }] })).toThrow(
      /inside the post folder/,
    );
    expect(() => localMediaPaths({ ...draft, media: [{ source: '/etc/passwd', type: 'image' }] })).toThrow();
    expect(() => localMediaPaths({ ...draft, media: [{ source: 'C:\\Windows\\x.jpg', type: 'image' }] })).toThrow();
    expect(() => localMediaPaths({ ...draft, media: [{ source: 'img\\..\\..\\x.jpg', type: 'image' }] })).toThrow();
  });

  it('stores media paths in the same form on every OS', () => {
    expect(localMediaPaths({ ...draft, media: [{ source: 'img\\a.jpg', type: 'image' }] })).toEqual(['img/a.jpg']);
    expect(localMediaPaths({ ...draft, media: [{ source: './img//a.jpg', type: 'image' }] })).toEqual(['img/a.jpg']);
  });

  it('requires approval and detects media swapped after approval', async () => {
    const dir = folder();
    await expect(requirePublishApproval(dir, draft)).rejects.toMatchObject({ code: 'APPROVAL_REQUIRED' });

    await approveCheckpoint({
      dir,
      def: PUBLISH_CHECKPOINT,
      files: publishFiles(dir, draft),
      tty: fakeTty(['approve']),
      summary: '',
    });
    await expect(requirePublishApproval(dir, draft)).resolves.toBeUndefined();

    appendFileSync(join(dir, 'img/a.jpg'), 'edited');
    await expect(requirePublishApproval(dir, draft)).rejects.toThrow(/img\/a.jpg changed/);
  });
});
