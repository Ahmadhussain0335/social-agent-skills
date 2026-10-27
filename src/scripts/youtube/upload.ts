import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { authorisedClient } from '../../platforms/youtube/client';
import { buildUploadPlan, FILES, writeUploadPlan } from '../../platforms/youtube/pipeline';
import { uploadApproved } from '../../platforms/youtube/upload';
import { loadState } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage:
  node scripts/upload.mjs --dir <project-folder> --plan [--file <video>] [--privacy private]
                          [--schedule <ISO date>] [--synthetic-media] [--notify-subscribers]
  node scripts/upload.mjs --dir <project-folder> [--allow-reupload]

Two steps:
  1. --plan writes upload-plan.json with the upload settings. Nothing is sent.
  2. After the user approves the "upload" checkpoint (state.mjs --approve upload),
     running without --plan uploads exactly the approved video, metadata, thumbnail
     and settings. Any change after approval blocks the upload.

Plan options:
  --file <path>            video, relative to the project folder (default output/video.mp4)
  --privacy <status>       private | unlisted | public (default private)
  --schedule <ISO date>    publish time, e.g. 2026-11-01T15:00:00Z; requires private
  --synthetic-media        disclose realistic altered or synthetic (AI) content to YouTube
  --notify-subscribers     notify subscribers (default off)

Upload options:
  --allow-reupload         upload a file that was already uploaded from this project
  -h, --help               show this help

Environment:
  YT_CLIENT_SECRET_PATH    OAuth "Desktop app" client JSON (required)
  YT_TOKEN_PATH            token from scripts/auth.mjs (default: config dir)

Quota: 1 videos.insert call (uploads bucket, 100/day) + 50 units for the thumbnail.
`;

runScript(
  HELP,
  {
    dir: { type: 'string' },
    plan: { type: 'boolean' },
    file: { type: 'string' },
    privacy: { type: 'string' },
    schedule: { type: 'string' },
    'synthetic-media': { type: 'boolean' },
    'notify-subscribers': { type: 'boolean' },
    'allow-reupload': { type: 'boolean' },
  },
  async (flags) => {
    const dir = resolve(requireFlag(flags, 'dir'));
    loadState(dir);

    if (flags.plan) {
      const plan = buildUploadPlan({
        file: flags.file as string | undefined,
        privacy: flags.privacy as string | undefined,
        schedule: flags.schedule as string | undefined,
        syntheticMedia: Boolean(flags['synthetic-media']),
        notifySubscribers: Boolean(flags['notify-subscribers']),
      });
      if (!existsSync(join(dir, plan.file))) {
        throw new PlatformError(
          'FILE_MISSING',
          `Video not found: ${plan.file}`,
          'Run the socialkit-youtube-assemble script first or pass --file.',
        );
      }
      writeUploadPlan(dir, plan);
      printJson({
        ok: true,
        wrote: FILES.uploadPlan,
        plan,
        next: 'Show the user the final video and this plan, then ask them to run: node <socialkit-youtube-pipeline>/scripts/state.mjs --dir <dir> --approve upload',
      });
      return;
    }

    const result = await uploadApproved({
      dir,
      getApi: () => authorisedClient(),
      allowReupload: Boolean(flags['allow-reupload']),
      onProgress: (sent, total) => process.stderr.write(`\ruploading ${Math.floor((sent / total) * 100)}%`),
    });
    process.stderr.write('\n');
    for (const warning of result.warnings) log.warn(warning);
    printJson({ ok: true, ...result });
  },
);
