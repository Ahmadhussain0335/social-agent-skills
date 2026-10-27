import { existsSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { type CheckpointDef, loadState, verifyCheckpoint } from './approval';
import { PlatformError } from './errors';

// A post folder holds one post for one platform: post.json plus local media files.
// The single "publish" checkpoint covers post.json and every local media file it lists,
// so editing the caption, swapping an image or changing the schedule needs a new approval.

export const POST_FILE = 'post.json';

export const PUBLISH_CHECKPOINT: CheckpointDef = { id: 'publish', title: 'Publish this exact post', requires: [] };

export interface PostMedia {
  /** Local file relative to the post folder, or an https URL the platform fetches. */
  source: string;
  type: 'image' | 'video';
  altText?: string;
}

export interface PostDraft {
  platform: string;
  /** Platform-specific post kind, e.g. feed, reel, story, carousel, text. */
  kind: string;
  text?: string;
  media?: PostMedia[];
  link?: string;
  /** ISO 8601; only for platforms that support scheduling through the API. */
  scheduledAt?: string;
  /** Platform-specific options, validated by the platform module. */
  options?: Record<string, unknown>;
}

export function isRemote(source: string): boolean {
  return /^https:\/\//i.test(source);
}

/** Local media paths must stay inside the post folder. */
export function localMediaPaths(draft: PostDraft): string[] {
  const paths: string[] = [];
  for (const media of draft.media ?? []) {
    if (isRemote(media.source)) continue;
    // Stored in POSIX form so an approval made on one OS verifies on another.
    const clean = posix.normalize(media.source.replace(/\\/g, '/'));
    if (posix.isAbsolute(clean) || win32.isAbsolute(media.source) || clean === '..' || clean.startsWith('../')) {
      throw new PlatformError('POST_MEDIA_OUTSIDE', `Media path must be inside the post folder: ${media.source}`);
    }
    paths.push(clean);
  }
  return paths;
}

export function publishFiles(dir: string, draft: PostDraft): string[] {
  const files = [POST_FILE, ...localMediaPaths(draft)];
  for (const file of files) {
    if (!existsSync(join(dir, file))) throw new PlatformError('FILE_MISSING', `${file} not found in ${dir}`);
  }
  return files;
}

/** Throws unless the "publish" checkpoint covers the current post.json and media byte for byte. */
export async function requirePublishApproval(dir: string, draft: PostDraft): Promise<void> {
  const result = await verifyCheckpoint(dir, loadState(dir), PUBLISH_CHECKPOINT.id, publishFiles(dir, draft));
  if (!result.ok) {
    throw new PlatformError(
      'APPROVAL_REQUIRED',
      `Publishing is not approved: ${result.problems.join('; ')}`,
      'Show the user the final post, then ask them to run the socialkit-social-core approve command in their own terminal.',
    );
  }
}

export function alreadyPublished(dir: string): string | undefined {
  const event = loadState(dir).history.find((h) => h.event === 'published');
  return event?.detail;
}
