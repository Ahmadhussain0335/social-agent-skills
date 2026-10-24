import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  buildFfmpegArgs,
  probeWithFfmpeg,
  resolveShotList,
  runFfmpeg,
  type ShotList,
} from '../../platforms/youtube/assemble';
import { FILES, readJson } from '../../platforms/youtube/pipeline';
import { PlatformError } from '../../shared/errors';
import { FFMPEG_MISSING_HINT, resolveFfmpeg } from '../../shared/ffmpeg';
import { printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/assemble.mjs --dir <project-folder> [--check] [--overwrite]

Renders <dir>/shot-list.json into an MP4 (H.264 + AAC, faststart) with FFmpeg.
All paths in the shot list are relative to the project folder.

shot-list.json:
  {
    "resolution": "1920x1080",          optional, default 1920x1080
    "fps": 30,                          optional, default 30
    "voiceover": "assets/voice.mp3",    optional narration track
    "music": { "file": "assets/bed.mp3", "volume": 0.15 },   optional, looped
    "subtitles": "assets/captions.srt", optional, muxed as a soft subtitle track
    "segments": [                       required, played in order
      { "file": "assets/intro.mp4", "duration": 5 },   video: duration optional
      { "file": "assets/slide-1.png", "duration": 8 }  image: duration required
    ],
    "output": "output/video.mp4"        optional
  }

Images and clips are scaled and letterboxed to the resolution. Clip audio is not used;
the soundtrack is the voiceover (plus music). The total length is the sum of segment
durations, and the check fails if the voiceover is longer than the visuals.

Options:
  --dir <path>     project folder (required)
  --check          validate the shot list and print the ffmpeg command without rendering
  --overwrite      replace an existing output file (this invalidates an "upload" approval)
  -h, --help       show this help

Environment:
  FFMPEG_PATH      ffmpeg binary to use; otherwise ffmpeg-static or ffmpeg on PATH
`;

runScript(
  HELP,
  { dir: { type: 'string' }, check: { type: 'boolean' }, overwrite: { type: 'boolean' } },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));
    const ffmpeg = resolveFfmpeg();
    if (!ffmpeg) throw new PlatformError('FFMPEG_MISSING', 'FFmpeg was not found.', FFMPEG_MISSING_HINT);

    const list = readJson<ShotList>(dir, FILES.shotList);
    const { plan, errors } = resolveShotList(list, dir, probeWithFfmpeg(ffmpeg.path));
    if (!plan) {
      printJson({ ok: false, errors });
      process.exitCode = 1;
      return;
    }

    const args = buildFfmpegArgs(list, plan, Boolean(flags.overwrite));
    if (flags.check) {
      printJson({
        ok: true,
        ffmpeg: ffmpeg.path,
        totalSeconds: plan.totalSeconds,
        voiceoverSeconds: plan.voiceoverSeconds,
        args,
      });
      return;
    }
    if (existsSync(join(dir, plan.output)) && !flags.overwrite) {
      throw new PlatformError('OUTPUT_EXISTS', `${plan.output} already exists.`, 'Pass --overwrite to replace it.');
    }

    await runFfmpeg(ffmpeg.path, args, dir, plan.output);
    printJson({ ok: true, output: join(dir, plan.output), totalSeconds: plan.totalSeconds });
  },
);
