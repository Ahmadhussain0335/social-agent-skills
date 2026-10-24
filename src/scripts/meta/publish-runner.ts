import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { CheckResult } from '../../platforms/meta/facebook';
import { loadState, saveState } from '../../shared/approval';
import { PlatformError } from '../../shared/errors';
import { log, printJson } from '../../shared/log';
import { alreadyPublished, POST_FILE, type PostDraft, requirePublishApproval } from '../../shared/post-project';
import { requireFlag, runScript } from '../run';

export interface PublishSpec {
  help: string;
  check: (draft: PostDraft) => CheckResult;
  publish: (dir: string, draft: PostDraft) => Promise<Record<string, unknown>>;
}

/** Shared flow for single-post platforms: --check validates; --publish requires approval and posts once. */
export function runPublishScript(spec: PublishSpec): void {
  runScript(
    spec.help,
    {
      dir: { type: 'string' },
      check: { type: 'boolean' },
      publish: { type: 'boolean' },
      'allow-repost': { type: 'boolean' },
    },
    async (flags) => {
      const dir = resolve(requireFlag(flags, 'dir'));
      const draft = JSON.parse(readFileSync(join(dir, POST_FILE), 'utf8')) as PostDraft;
      const report = spec.check(draft);

      if (flags.check || !flags.publish) {
        printJson(report);
        if (!report.ok) process.exitCode = 1;
        return;
      }
      if (!report.ok) throw new PlatformError('POST_INVALID', report.errors.join('; '));
      for (const warning of report.warnings) log.warn(warning);

      await requirePublishApproval(dir, draft);
      const previous = alreadyPublished(dir);
      if (previous && !flags['allow-repost']) {
        throw new PlatformError(
          'ALREADY_PUBLISHED',
          `This post folder was already published (${previous}).`,
          'Pass --allow-repost only if the user explicitly wants to post it again.',
        );
      }

      const result = await spec.publish(dir, draft);
      const state = loadState(dir);
      state.history.push({ at: new Date().toISOString(), event: 'published', detail: String(result.id ?? '') });
      saveState(dir, state);
      printJson({ ok: true, ...result, warnings: report.warnings });
    },
  );
}
