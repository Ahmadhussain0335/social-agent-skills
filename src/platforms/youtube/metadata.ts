import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Limits from the YouTube Data API video resource docs (snippet.title, snippet.description,
// snippet.tags) and thumbnails.set (max 2 MB; JPEG or PNG).
export const LIMITS = {
  titleChars: 100,
  descriptionBytes: 5000,
  tagsChars: 500,
  thumbnailBytes: 2 * 1024 * 1024,
  thumbnailMinWidth: 640,
} as const;

export interface VideoMetadata {
  title: string;
  description: string;
  tags?: string[];
  categoryId?: string;
  defaultLanguage?: string;
  /** Required by YouTube for COPPA; must be set explicitly, never defaulted. */
  madeForKids: boolean;
  /** Thumbnail path relative to the project folder. */
  thumbnail?: string;
}

export interface MetadataReport {
  ok: boolean;
  errors: string[];
  warnings: string[];
  stats: { titleChars: number; descriptionBytes: number; tagsChars: number; thumbnail?: ImageInfo };
}

export interface ImageInfo {
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  bytes: number;
}

/** Tag length as YouTube counts it: tags with spaces are quoted, and separators count. */
export function tagsLength(tags: readonly string[]): number {
  if (tags.length === 0) return 0;
  const body = tags.reduce((sum, tag) => sum + tag.length + (tag.includes(' ') ? 2 : 0), 0);
  return body + (tags.length - 1);
}

export function checkMetadata(raw: unknown, projectDir: string): MetadataReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const m = (raw ?? {}) as Partial<VideoMetadata>;

  const title = typeof m.title === 'string' ? m.title : '';
  const description = typeof m.description === 'string' ? m.description : '';
  const tags = Array.isArray(m.tags) ? m.tags : [];

  if (!title.trim()) errors.push('title is required');
  if ([...title].length > LIMITS.titleChars) errors.push(`title exceeds ${LIMITS.titleChars} characters`);
  if (/[<>]/.test(title)) errors.push('title must not contain < or >');

  const descriptionBytes = Buffer.byteLength(description, 'utf8');
  if (!description.trim()) warnings.push('description is empty');
  if (descriptionBytes > LIMITS.descriptionBytes) {
    errors.push(`description exceeds ${LIMITS.descriptionBytes} bytes (${descriptionBytes})`);
  }
  if (/[<>]/.test(description)) errors.push('description must not contain < or >');

  if (m.tags !== undefined && (!Array.isArray(m.tags) || m.tags.some((t) => typeof t !== 'string'))) {
    errors.push('tags must be an array of strings');
  }
  const tagsChars = tagsLength(tags);
  if (tagsChars > LIMITS.tagsChars) errors.push(`tags total ${tagsChars} characters; limit is ${LIMITS.tagsChars}`);
  if (tags.some((t) => t.includes(','))) errors.push('tags must not contain commas');

  if (typeof m.madeForKids !== 'boolean') {
    errors.push('madeForKids must be set to true or false explicitly (YouTube COPPA requirement)');
  }
  if (m.categoryId !== undefined && !/^\d+$/.test(String(m.categoryId))) {
    errors.push('categoryId must be a numeric string, e.g. "22"');
  }

  let thumbnail: ImageInfo | undefined;
  if (m.thumbnail) {
    const path = join(projectDir, m.thumbnail);
    if (!existsSync(path)) {
      errors.push(`thumbnail not found: ${m.thumbnail}`);
    } else {
      thumbnail = readImageInfo(path);
      if (!thumbnail) {
        errors.push('thumbnail must be a PNG or JPEG file');
      } else {
        if (thumbnail.bytes > LIMITS.thumbnailBytes) errors.push('thumbnail exceeds 2 MB');
        if (thumbnail.width < LIMITS.thumbnailMinWidth) {
          errors.push(`thumbnail width ${thumbnail.width}px is below the ${LIMITS.thumbnailMinWidth}px minimum`);
        }
        if (Math.abs(thumbnail.width / thumbnail.height - 16 / 9) > 0.02) {
          warnings.push(
            `thumbnail is ${thumbnail.width}x${thumbnail.height}; YouTube recommends 16:9, ideally 1280x720`,
          );
        }
      }
    }
  } else {
    warnings.push('no thumbnail set; YouTube will pick a frame');
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    stats: { titleChars: [...title].length, descriptionBytes, tagsChars, thumbnail },
  };
}

export function readImageInfo(path: string): ImageInfo | undefined {
  const buf = readFileSync(path);
  const bytes = statSync(path).size;

  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { format: 'png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), bytes };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buf.length) {
      if (buf[offset] !== 0xff) return undefined;
      const marker = buf[offset + 1] as number;
      const length = buf.readUInt16BE(offset + 2);
      // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { format: 'jpeg', height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7), bytes };
      }
      offset += 2 + length;
    }
  }
  return undefined;
}
