import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { PlatformError } from './errors';
import type { Tty } from './prompt';

// Human approval checkpoints. An approval records the sha256 of every file it covers;
// publishing scripts verify those hashes, so any change after approval needs a new approval.
// Approving requires an interactive terminal so an agent running commands without one
// cannot approve on the user's behalf. This makes self-approval visible, not impossible:
// anyone who can edit state.json can forge it.

export const STATE_FILE = 'state.json';

export interface CheckpointRecord {
  approvedAt: string;
  approvedBy: string;
  files: Record<string, string>;
}

export interface PipelineState {
  version: 1;
  slug: string;
  createdAt: string;
  checkpoints: Record<string, CheckpointRecord>;
  history: Array<{ at: string; event: string; detail?: string }>;
}

export interface CheckpointDef {
  id: string;
  title: string;
  requires: readonly string[];
}

export function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')));
  });
}

export function newState(slug: string, now = new Date()): PipelineState {
  return {
    version: 1,
    slug,
    createdAt: now.toISOString(),
    checkpoints: {},
    history: [{ at: now.toISOString(), event: 'created' }],
  };
}

export function loadState(dir: string): PipelineState {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) {
    throw new PlatformError(
      'NO_PIPELINE_STATE',
      `No ${STATE_FILE} in ${dir}.`,
      'Initialise the project folder with the pipeline state script first.',
    );
  }
  return JSON.parse(readFileSync(path, 'utf8')) as PipelineState;
}

export function saveState(dir: string, state: PipelineState): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, STATE_FILE), `${JSON.stringify(state, null, 2)}\n`);
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

export async function verifyCheckpoint(
  dir: string,
  state: PipelineState,
  checkpoint: string,
  files: readonly string[],
): Promise<VerifyResult> {
  const record = state.checkpoints[checkpoint];
  if (!record) return { ok: false, problems: [`checkpoint "${checkpoint}" has not been approved`] };

  const problems: string[] = [];
  for (const file of files) {
    const approved = record.files[file];
    if (!approved) {
      problems.push(`${file} was not part of the "${checkpoint}" approval`);
      continue;
    }
    const path = join(dir, file);
    if (!existsSync(path)) {
      problems.push(`${file} is missing`);
    } else if ((await hashFile(path)) !== approved) {
      problems.push(`${file} changed after the "${checkpoint}" approval`);
    }
  }
  return { ok: problems.length === 0, problems };
}

export interface ApproveOptions {
  dir: string;
  def: CheckpointDef;
  files: readonly string[];
  tty: Tty;
  /** Printed before the confirmation so the user sees exactly what they approve. */
  summary: string;
  now?: Date;
}

export async function approveCheckpoint(opts: ApproveOptions): Promise<CheckpointRecord> {
  const { dir, def, files, tty } = opts;
  if (!tty.isInteractive()) {
    throw new PlatformError(
      'APPROVAL_NEEDS_TERMINAL',
      `Approving "${def.id}" requires a person at an interactive terminal.`,
      'Ask the user to run this approve command themselves in their own terminal.',
    );
  }

  const state = loadState(dir);
  for (const required of def.requires) {
    const result = await verifyCheckpoint(dir, state, required, Object.keys(state.checkpoints[required]?.files ?? {}));
    if (!result.ok) {
      throw new PlatformError(
        'CHECKPOINT_ORDER',
        `"${def.id}" needs a valid "${required}" approval first: ${result.problems.join('; ')}`,
      );
    }
  }

  const hashes: Record<string, string> = {};
  for (const file of files) {
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw new PlatformError('APPROVAL_FILE_MISSING', `Cannot approve: ${file} does not exist.`);
    }
    hashes[file] = await hashFile(path);
  }

  const answer = await tty.ask(
    `\n${opts.summary}\n\nCheckpoint: ${def.title}\nType "approve" to approve, anything else to cancel: `,
  );
  if (answer !== 'approve') {
    throw new PlatformError('APPROVAL_DECLINED', `Checkpoint "${def.id}" was not approved.`);
  }

  const at = (opts.now ?? new Date()).toISOString();
  const record: CheckpointRecord = { approvedAt: at, approvedBy: userInfo().username, files: hashes };
  state.checkpoints[def.id] = record;
  state.history.push({ at, event: `approved:${def.id}` });
  saveState(dir, state);
  return record;
}
