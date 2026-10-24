import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { PlatformError } from '../../shared/errors';
import { FILES } from './pipeline';

export interface Segment {
  file: string;
  /** Seconds. Required for images; optional for video clips (defaults to clip length). */
  duration?: number;
  note?: string;
}

export interface ShotList {
  resolution?: string;
  fps?: number;
  voiceover?: string;
  music?: { file: string; volume?: number };
  subtitles?: string;
  segments: Segment[];
  output?: string;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.bmp']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);

export function isImage(file: string): boolean {
  return IMAGE_EXT.has(extname(file).toLowerCase());
}

export interface ResolvedPlan {
  width: number;
  height: number;
  fps: number;
  output: string;
  segments: Array<Segment & { duration: number; kind: 'image' | 'video' }>;
  totalSeconds: number;
  voiceoverSeconds?: number;
}

export type Probe = (file: string) => number | undefined;

/** Validates the shot list and resolves every duration. Paths are relative to dir. */
export function resolveShotList(list: ShotList, dir: string, probe: Probe): { plan?: ResolvedPlan; errors: string[] } {
  const errors: string[] = [];
  const [w, h] = (list.resolution ?? '1920x1080').split('x').map(Number);
  const width = w ?? 0;
  const height = h ?? 0;
  if (!width || !height || width % 2 || height % 2)
    errors.push('resolution must be WIDTHxHEIGHT with even numbers, e.g. 1920x1080');
  const fps = list.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 120) errors.push('fps must be between 1 and 120');

  if (!Array.isArray(list.segments) || list.segments.length === 0) errors.push('segments must list at least one file');

  const segments: ResolvedPlan['segments'] = [];
  for (const [i, seg] of (list.segments ?? []).entries()) {
    const label = `segments[${i}] (${seg.file})`;
    if (!seg.file || !existsSync(join(dir, seg.file))) {
      errors.push(`${label}: file not found`);
      continue;
    }
    const ext = extname(seg.file).toLowerCase();
    const kind = IMAGE_EXT.has(ext) ? 'image' : VIDEO_EXT.has(ext) ? 'video' : undefined;
    if (!kind) {
      errors.push(`${label}: unsupported file type ${ext}`);
      continue;
    }
    let duration = seg.duration;
    if (duration === undefined && kind === 'video') duration = probe(join(dir, seg.file));
    if (duration === undefined || !(duration > 0)) {
      errors.push(
        `${label}: ${kind === 'image' ? 'images need a positive duration in seconds' : 'could not read clip length; set duration'}`,
      );
      continue;
    }
    segments.push({ ...seg, duration, kind });
  }

  for (const [field, file] of [
    ['voiceover', list.voiceover],
    ['music.file', list.music?.file],
    ['subtitles', list.subtitles],
  ] as const) {
    if (file && !existsSync(join(dir, file))) errors.push(`${field}: file not found (${file})`);
  }
  if (list.music?.volume !== undefined && !(list.music.volume >= 0 && list.music.volume <= 1)) {
    errors.push('music.volume must be between 0 and 1');
  }

  const totalSeconds = round(segments.reduce((sum, s) => sum + s.duration, 0));
  let voiceoverSeconds: number | undefined;
  if (list.voiceover && existsSync(join(dir, list.voiceover))) {
    voiceoverSeconds = probe(join(dir, list.voiceover));
    if (voiceoverSeconds !== undefined && voiceoverSeconds > totalSeconds + 0.05) {
      errors.push(
        `visuals total ${totalSeconds}s but the voiceover is ${round(voiceoverSeconds)}s; extend segment durations so the voiceover is not cut off`,
      );
    }
  }

  if (errors.length > 0) return { errors };
  return {
    errors,
    plan: { width, height, fps, output: list.output ?? FILES.defaultVideo, segments, totalSeconds, voiceoverSeconds },
  };
}

/** Builds ffmpeg arguments. Nothing is passed through a shell. */
export function buildFfmpegArgs(list: ShotList, plan: ResolvedPlan, overwrite: boolean): string[] {
  const args: string[] = ['-hide_banner', overwrite ? '-y' : '-n'];
  const { width: W, height: H, fps } = plan;

  for (const seg of plan.segments) {
    if (seg.kind === 'image') args.push('-loop', '1', '-framerate', String(fps));
    args.push('-t', String(seg.duration), '-i', seg.file);
  }
  let next = plan.segments.length;
  const voiceIdx = list.voiceover ? next++ : undefined;
  if (list.voiceover) args.push('-i', list.voiceover);
  const musicIdx = list.music ? next++ : undefined;
  if (list.music) args.push('-stream_loop', '-1', '-i', list.music.file);
  const silenceIdx = !list.voiceover && !list.music ? next++ : undefined;
  if (silenceIdx !== undefined) args.push('-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo');
  const subsIdx = list.subtitles ? next++ : undefined;
  if (list.subtitles) args.push('-i', list.subtitles);

  const filters: string[] = plan.segments.map(
    (_, i) =>
      `[${i}:v]scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${fps},format=yuv420p[v${i}]`,
  );
  filters.push(`${plan.segments.map((_, i) => `[v${i}]`).join('')}concat=n=${plan.segments.length}:v=1:a=0[vout]`);

  const volume = list.music?.volume ?? 0.15;
  if (voiceIdx !== undefined && musicIdx !== undefined) {
    filters.push(`[${voiceIdx}:a]apad[vo]`, `[${musicIdx}:a]volume=${volume}[mu]`);
    filters.push('[vo][mu]amix=inputs=2:duration=first:dropout_transition=0:normalize=0[aout]');
  } else if (voiceIdx !== undefined) {
    filters.push(`[${voiceIdx}:a]apad[aout]`);
  } else if (musicIdx !== undefined) {
    filters.push(`[${musicIdx}:a]volume=${volume}[aout]`);
  } else {
    filters.push(`[${silenceIdx}:a]anull[aout]`);
  }

  args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]');
  if (subsIdx !== undefined) args.push('-map', `${subsIdx}:s`, '-c:s', 'mov_text');
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'medium',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-r',
    String(fps),
    '-c:a',
    'aac',
    '-b:a',
    '192k',
    '-ar',
    '48000',
    '-t',
    String(plan.totalSeconds),
    '-movflags',
    '+faststart',
    plan.output,
  );
  return args;
}

/** Reads a media duration from ffmpeg's banner; ffmpeg-static ships without ffprobe. */
export function probeWithFfmpeg(ffmpeg: string): Probe {
  return (file) => {
    const result = spawnSync(ffmpeg, ['-hide_banner', '-i', file], { encoding: 'utf8' });
    const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(result.stderr ?? '');
    if (!match) return undefined;
    return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  };
}

export function runFfmpeg(ffmpeg: string, args: string[], cwd: string, output: string): Promise<void> {
  mkdirSync(join(cwd, dirname(output)), { recursive: true });
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let tail = '';
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      tail = (tail + text).slice(-4000);
      const time = /time=(\d+:\d+:\d+\.\d+)/.exec(text);
      if (time) process.stderr.write(`\rencoding ${time[1]}`);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      process.stderr.write('\n');
      if (code === 0) resolve();
      else
        reject(
          new PlatformError(
            'FFMPEG_FAILED',
            `ffmpeg exited with code ${code}`,
            tail.trim().split('\n').slice(-5).join('\n'),
          ),
        );
    });
  });
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
