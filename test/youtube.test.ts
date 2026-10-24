import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { errorReason, toYouTubeError } from '../src/platforms/youtube/errors';
import { checkMetadata, readImageInfo, tagsLength } from '../src/platforms/youtube/metadata';
import { buildUploadPlan, checkpointFiles, writeUploadPlan } from '../src/platforms/youtube/pipeline';
import { researchVideos } from '../src/platforms/youtube/research';
import { uploadApproved } from '../src/platforms/youtube/upload';
import { approveCheckpoint, newState, saveState } from '../src/shared/approval';
import { fakeTty, pngHeader, tmp, write } from './helpers';

const NOW = new Date('2026-10-23T12:00:00Z');

describe('metadata check', () => {
  const base = { title: 'How BLE pairing works', description: 'Plain explanation.', madeForKids: false };

  it('accepts valid metadata', () => {
    expect(checkMetadata(base, tmp())).toMatchObject({ ok: true, errors: [] });
  });

  it('enforces YouTube limits', () => {
    const report = checkMetadata(
      {
        title: `${'x'.repeat(101)}<`,
        description: 'é'.repeat(2501),
        tags: ['a,b'],
        categoryId: 'music',
      },
      tmp(),
    );
    expect(report.errors).toEqual([
      'title exceeds 100 characters',
      'title must not contain < or >',
      'description exceeds 5000 bytes (5002)',
      'tags must not contain commas',
      'madeForKids must be set to true or false explicitly (YouTube COPPA requirement)',
      'categoryId must be a numeric string, e.g. "22"',
    ]);
  });

  it('counts tags the way YouTube does', () => {
    expect(tagsLength(['ble', 'iot gateway'])).toBe(3 + 13 + 1);
    expect(tagsLength([])).toBe(0);
  });

  it('checks thumbnail size and aspect ratio', () => {
    const dir = tmp();
    write(join(dir, 'thumb.png'), pngHeader(1280, 720));
    write(join(dir, 'small.png'), pngHeader(320, 320));
    expect(readImageInfo(join(dir, 'thumb.png'))).toMatchObject({ format: 'png', width: 1280, height: 720 });
    expect(checkMetadata({ ...base, thumbnail: 'thumb.png' }, dir).ok).toBe(true);
    const small = checkMetadata({ ...base, thumbnail: 'small.png' }, dir);
    expect(small.errors).toEqual(['thumbnail width 320px is below the 640px minimum']);
    expect(small.warnings[0]).toMatch(/16:9/);
  });

  it('reads JPEG dimensions from the SOF marker', () => {
    const dir = tmp();
    const sof = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x02, 0xd0, 0x05, 0x00, 0x03,
    ]);
    write(join(dir, 't.jpg'), sof);
    expect(readImageInfo(join(dir, 't.jpg'))).toMatchObject({ format: 'jpeg', width: 1280, height: 720 });
  });
});

describe('upload plan', () => {
  it('defaults to private with no disclosure and no notifications', () => {
    expect(buildUploadPlan({}, NOW)).toEqual({
      file: 'output/video.mp4',
      privacyStatus: 'private',
      containsSyntheticMedia: false,
      notifySubscribers: false,
    });
  });

  it('accepts a future schedule only for private videos', () => {
    expect(buildUploadPlan({ schedule: '2026-11-01T15:00:00Z', syntheticMedia: true }, NOW)).toMatchObject({
      privacyStatus: 'private',
      publishAt: '2026-11-01T15:00:00.000Z',
      containsSyntheticMedia: true,
    });
    expect(() => buildUploadPlan({ schedule: '2026-11-01T15:00:00Z', privacy: 'public' }, NOW)).toThrow(
      /must be uploaded as private/,
    );
    expect(() => buildUploadPlan({ schedule: '2026-01-01T00:00:00Z' }, NOW)).toThrow(/future/);
    expect(() => buildUploadPlan({ schedule: 'tomorrow' }, NOW)).toThrow(/ISO 8601/);
    expect(() => buildUploadPlan({ privacy: 'friends' }, NOW)).toThrow(/--privacy/);
  });
});

function approvedProject() {
  const dir = tmp();
  saveState(dir, newState('demo'));
  write(join(dir, 'script.md'), 'script');
  write(
    join(dir, 'metadata.json'),
    JSON.stringify({ title: 'T', description: 'D', madeForKids: false, thumbnail: 'thumb.png', tags: ['ble'] }),
  );
  write(join(dir, 'thumb.png'), pngHeader(1280, 720));
  write(join(dir, 'output/video.mp4'), 'fake video bytes');
  writeUploadPlan(dir, buildUploadPlan({ schedule: '2099-01-01T00:00:00Z', syntheticMedia: true }));
  return dir;
}

async function approveAll(dir: string) {
  const defs = [
    { id: 'script', title: 's', requires: [] },
    { id: 'metadata', title: 'm', requires: ['script'] },
    { id: 'upload', title: 'u', requires: ['metadata'] },
  ];
  for (const def of defs) {
    await approveCheckpoint({ dir, def, files: checkpointFiles(dir, def.id), tty: fakeTty(['approve']), summary: '' });
  }
}

function fakeApi(status: Record<string, unknown> = { privacyStatus: 'private' }) {
  return {
    videos: { insert: vi.fn().mockResolvedValue({ data: { id: 'vid123', status } }) },
    thumbnails: { set: vi.fn().mockResolvedValue({ data: {} }) },
  };
}

describe('uploadApproved', () => {
  const env = () => ({ SOCIAL_SKILLS_CONFIG_DIR: tmp() });

  it('refuses without the upload approval and never loads credentials', async () => {
    const dir = approvedProject();
    const getApi = vi.fn(() => fakeApi() as never);
    await expect(uploadApproved({ dir, getApi, env: env() })).rejects.toMatchObject({
      code: 'APPROVAL_REQUIRED',
    });
    expect(getApi).not.toHaveBeenCalled();
  });

  it('refuses when a file changed after approval', async () => {
    const dir = approvedProject();
    await approveAll(dir);
    write(join(dir, 'output/video.mp4'), 'different cut');
    const api = fakeApi();
    await expect(uploadApproved({ dir, getApi: () => api as never, env: env() })).rejects.toThrow(
      /output\/video.mp4 changed/,
    );
    expect(api.videos.insert).not.toHaveBeenCalled();
  });

  it('uploads exactly the approved settings and records the upload', async () => {
    const dir = approvedProject();
    await approveAll(dir);
    const api = fakeApi();
    const result = await uploadApproved({ dir, getApi: () => api as never, env: env() });

    const request = api.videos.insert.mock.calls[0]?.[0];
    expect(request.part).toEqual(['snippet', 'status']);
    expect(request.notifySubscribers).toBe(false);
    expect(request.requestBody.status).toEqual({
      privacyStatus: 'private',
      publishAt: '2099-01-01T00:00:00.000Z',
      selfDeclaredMadeForKids: false,
      containsSyntheticMedia: true,
    });
    expect(request.requestBody.snippet).toMatchObject({ title: 'T', tags: ['ble'], categoryId: '22' });
    expect(api.thumbnails.set).toHaveBeenCalledWith(expect.objectContaining({ videoId: 'vid123' }));
    expect(result).toMatchObject({ videoId: 'vid123', thumbnail: 'set', warnings: [] });

    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    expect(state.history.at(-1).event).toBe('uploaded');
    await expect(uploadApproved({ dir, getApi: () => api as never, env: env() })).rejects.toMatchObject({
      code: 'YT_ALREADY_UPLOADED',
    });
  });

  it('warns when YouTube sets a different privacy and when the thumbnail fails', async () => {
    const dir = approvedProject();
    writeUploadPlan(dir, buildUploadPlan({ privacy: 'public' }));
    await approveAll(dir);
    const api = fakeApi({ privacyStatus: 'private' });
    api.thumbnails.set.mockRejectedValue({ errors: [{ reason: 'forbidden' }], message: 'forbidden' });
    const result = await uploadApproved({ dir, getApi: () => api as never, env: env() });
    expect(result.actualPrivacy).toBe('private');
    expect(result.thumbnail).toBe('failed');
    expect(result.warnings).toHaveLength(2);
  });

  it('maps quota errors to an actionable message', async () => {
    const dir = approvedProject();
    await approveAll(dir);
    const api = fakeApi();
    api.videos.insert.mockRejectedValue({
      response: { status: 403, data: { error: { errors: [{ reason: 'quotaExceeded' }] } } },
    });
    await expect(uploadApproved({ dir, getApi: () => api as never, env: env() })).rejects.toMatchObject({
      code: 'YT_QUOTA_EXCEEDED',
      hint: expect.stringMatching(/midnight Pacific Time/),
    });
  });
});

describe('errors', () => {
  it('extracts reasons from API and OAuth errors', () => {
    expect(errorReason({ errors: [{ reason: 'uploadLimitExceeded' }] })).toBe('uploadLimitExceeded');
    expect(errorReason({ response: { data: { error: 'invalid_grant' } } })).toBe('invalid_grant');
    expect(toYouTubeError({ response: { data: { error: 'invalid_grant' } } }).code).toBe('YT_TOKEN_EXPIRED');
    expect(toYouTubeError(new Error('boom')).code).toBe('YT_API_ERROR');
  });
});

describe('research', () => {
  it('joins search results with statistics and spends both buckets', async () => {
    const api = {
      search: { list: vi.fn().mockResolvedValue({ data: { items: [{ id: { videoId: 'a' } }] } }) },
      videos: {
        list: vi.fn().mockResolvedValue({
          data: {
            items: [
              {
                id: 'a',
                snippet: { title: 'A', channelTitle: 'C', tags: ['x'] },
                statistics: { viewCount: '10' },
                contentDetails: { duration: 'PT1M' },
              },
            ],
          },
        }),
      },
    };
    const configDir = tmp();
    const videos = await researchVideos(
      api as never,
      { query: 'ble', max: 500 },
      { SOCIAL_SKILLS_CONFIG_DIR: configDir },
    );
    expect(api.search.list.mock.calls[0]?.[0].maxResults).toBe(50);
    expect(videos).toEqual([expect.objectContaining({ videoId: 'a', views: 10, likes: 0, duration: 'PT1M' })]);
    expect(JSON.parse(readFileSync(join(configDir, 'youtube', 'quota-search.json'), 'utf8')).used).toBe(1);
  });
});
