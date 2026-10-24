import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckpointDef } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import type { VideoMetadata } from './metadata';

// Project folder layout shared by the youtube-* skills.
export const FILES = {
  research: 'research.md',
  script: 'script.md',
  shotList: 'shot-list.json',
  metadata: 'metadata.json',
  uploadPlan: 'upload-plan.json',
  defaultVideo: 'output/video.mp4',
} as const;

export const CHECKPOINTS: readonly CheckpointDef[] = [
  { id: 'script', title: '1/3 Script draft', requires: [] },
  { id: 'metadata', title: '2/3 Final title, description and thumbnail', requires: ['script'] },
  { id: 'upload', title: '3/3 Upload: video file, metadata and upload settings', requires: ['metadata'] },
];

export function checkpointDef(id: string): CheckpointDef {
  const def = CHECKPOINTS.find((c) => c.id === id);
  if (!def) {
    throw new PlatformError(
      'UNKNOWN_CHECKPOINT',
      `Unknown checkpoint "${id}". Use one of: ${CHECKPOINTS.map((c) => c.id).join(', ')}`,
    );
  }
  return def;
}

export type PrivacyStatus = 'private' | 'unlisted' | 'public';

export interface UploadPlan {
  file: string;
  privacyStatus: PrivacyStatus;
  publishAt?: string;
  containsSyntheticMedia: boolean;
  notifySubscribers: boolean;
}

export function readJson<T>(dir: string, file: string): T {
  const path = join(dir, file);
  if (!existsSync(path)) throw new PlatformError('FILE_MISSING', `${file} not found in ${dir}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch (error) {
    throw new PlatformError('INVALID_JSON', `${file} is not valid JSON: ${(error as Error).message}`);
  }
}

export function readMetadata(dir: string): VideoMetadata {
  return readJson<VideoMetadata>(dir, FILES.metadata);
}

export function readUploadPlan(dir: string): UploadPlan {
  return readJson<UploadPlan>(dir, FILES.uploadPlan);
}

/** Files each checkpoint covers. Later checkpoints re-cover earlier files so late edits are caught. */
export function checkpointFiles(dir: string, id: string): string[] {
  switch (checkpointDef(id).id) {
    case 'script':
      return [FILES.script];
    case 'metadata': {
      const meta = readMetadata(dir);
      return [FILES.metadata, ...(meta.thumbnail ? [meta.thumbnail] : [])];
    }
    default: {
      const meta = readMetadata(dir);
      const plan = readUploadPlan(dir);
      return [plan.file, FILES.metadata, ...(meta.thumbnail ? [meta.thumbnail] : []), FILES.uploadPlan];
    }
  }
}

export interface PlanInput {
  file?: string;
  privacy?: string;
  schedule?: string;
  syntheticMedia?: boolean;
  notifySubscribers?: boolean;
}

export function buildUploadPlan(input: PlanInput, now = new Date()): UploadPlan {
  const privacyStatus = (input.privacy ?? 'private') as PrivacyStatus;
  if (!['private', 'unlisted', 'public'].includes(privacyStatus)) {
    throw new PlatformError(
      'INVALID_PRIVACY',
      `--privacy must be private, unlisted or public (got "${input.privacy}")`,
    );
  }

  let publishAt: string | undefined;
  if (input.schedule) {
    const when = new Date(input.schedule);
    if (Number.isNaN(when.getTime())) {
      throw new PlatformError('YT_INVALID_SCHEDULE', `--schedule "${input.schedule}" is not a valid ISO 8601 date.`);
    }
    if (when.getTime() <= now.getTime()) {
      throw new PlatformError('YT_INVALID_SCHEDULE', '--schedule must be in the future.');
    }
    if (privacyStatus !== 'private') {
      throw new PlatformError(
        'YT_INVALID_SCHEDULE',
        'Scheduled videos must be uploaded as private; YouTube makes them public at the scheduled time.',
      );
    }
    publishAt = when.toISOString();
  }

  return {
    file: input.file ?? FILES.defaultVideo,
    privacyStatus,
    ...(publishAt ? { publishAt } : {}),
    containsSyntheticMedia: Boolean(input.syntheticMedia),
    notifySubscribers: Boolean(input.notifySubscribers),
  };
}

export function writeUploadPlan(dir: string, plan: UploadPlan): void {
  writeFileSync(join(dir, FILES.uploadPlan), `${JSON.stringify(plan, null, 2)}\n`);
}
