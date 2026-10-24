import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { youtube_v3 } from '@googleapis/youtube';
import { hashFile, loadState, saveState, verifyCheckpoint } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { spendQuota } from './config';
import { toYouTubeError } from './errors';
import { checkMetadata } from './metadata';
import { checkpointFiles, readMetadata, readUploadPlan } from './pipeline';

export interface UploadResult {
  videoId: string;
  url: string;
  studioUrl: string;
  requestedPrivacy: string;
  actualPrivacy?: string;
  publishAt?: string;
  containsSyntheticMedia: boolean;
  thumbnail: 'set' | 'none' | 'failed';
  warnings: string[];
}

export interface UploadOptions {
  dir: string;
  /** Called only after approval and inputs are verified, so credentials are not touched before that. */
  getApi: () => Pick<youtube_v3.Youtube, 'videos' | 'thumbnails'>;
  env?: NodeJS.ProcessEnv;
  allowReupload?: boolean;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
}

/** Uploads only what the user approved at the "upload" checkpoint, byte for byte. */
export async function uploadApproved(opts: UploadOptions): Promise<UploadResult> {
  const { dir } = opts;
  const env = opts.env ?? process.env;
  const state = loadState(dir);

  const files = checkpointFiles(dir, 'upload');
  const verified = await verifyCheckpoint(dir, state, 'upload', files);
  if (!verified.ok) {
    throw new PlatformError(
      'APPROVAL_REQUIRED',
      `Upload is not approved: ${verified.problems.join('; ')}`,
      'Show the user the final video, metadata and upload plan, then ask them to run the approve command for the "upload" checkpoint in their own terminal.',
    );
  }

  const meta = readMetadata(dir);
  const report = checkMetadata(meta, dir);
  if (!report.ok)
    throw new PlatformError('YT_INVALID_METADATA', `metadata.json is invalid: ${report.errors.join('; ')}`);
  const plan = readUploadPlan(dir);
  const videoPath = join(dir, plan.file);
  if (!existsSync(videoPath)) throw new PlatformError('FILE_MISSING', `Video not found: ${plan.file}`);

  const videoHash = await hashFile(videoPath);
  const previous = state.history.find((h) => h.event === 'uploaded' && h.detail?.includes(videoHash));
  if (previous && !opts.allowReupload) {
    throw new PlatformError(
      'YT_ALREADY_UPLOADED',
      `This exact video file was already uploaded (${previous.detail?.split(' ')[0]}).`,
      'Pass --allow-reupload only if the user explicitly wants a second copy on the channel.',
    );
  }

  const api = opts.getApi();
  spendQuota('videos.insert', env);
  const totalBytes = statSync(videoPath).size;
  let response: youtube_v3.Schema$Video;
  try {
    const res = await api.videos.insert(
      {
        part: ['snippet', 'status'],
        notifySubscribers: plan.notifySubscribers,
        requestBody: {
          snippet: {
            title: meta.title,
            description: meta.description,
            tags: meta.tags,
            categoryId: meta.categoryId ?? '22',
            defaultLanguage: meta.defaultLanguage,
          },
          status: {
            privacyStatus: plan.privacyStatus,
            publishAt: plan.publishAt,
            selfDeclaredMadeForKids: meta.madeForKids,
            containsSyntheticMedia: plan.containsSyntheticMedia,
          },
        },
        media: { body: createReadStream(videoPath) },
      },
      {
        onUploadProgress: (event: { bytesRead: number }) => opts.onProgress?.(event.bytesRead, totalBytes),
      },
    );
    response = res.data;
  } catch (error) {
    throw toYouTubeError(error);
  }

  const videoId = response.id;
  if (!videoId) throw new PlatformError('YT_API_ERROR', 'YouTube returned no video id.');

  const warnings: string[] = [];
  const actualPrivacy = response.status?.privacyStatus ?? undefined;
  if (actualPrivacy && actualPrivacy !== plan.privacyStatus) {
    warnings.push(
      `Requested privacy "${plan.privacyStatus}" but YouTube set "${actualPrivacy}". YouTube can lock uploads as private (for example after a policy or audit restriction on the API project); check the video in YouTube Studio.`,
    );
  }

  let thumbnail: UploadResult['thumbnail'] = 'none';
  if (meta.thumbnail) {
    try {
      spendQuota('thumbnails.set', env);
      await api.thumbnails.set({
        videoId,
        media: {
          mimeType: extname(meta.thumbnail).toLowerCase() === '.png' ? 'image/png' : 'image/jpeg',
          body: createReadStream(join(dir, meta.thumbnail)),
        },
      });
      thumbnail = 'set';
    } catch (error) {
      thumbnail = 'failed';
      warnings.push(
        `Video uploaded but the thumbnail failed: ${toYouTubeError(error).message} Custom thumbnails require a verified channel (youtube.com/verify). Set it in YouTube Studio instead.`,
      );
    }
  }

  state.history.push({ at: new Date().toISOString(), event: 'uploaded', detail: `${videoId} ${videoHash}` });
  saveState(dir, state);

  return {
    videoId,
    url: `https://www.youtube.com/watch?v=${videoId}`,
    studioUrl: `https://studio.youtube.com/video/${videoId}/edit`,
    requestedPrivacy: plan.privacyStatus,
    actualPrivacy,
    publishAt: plan.publishAt,
    containsSyntheticMedia: plan.containsSyntheticMedia,
    thumbnail,
    warnings,
  };
}
