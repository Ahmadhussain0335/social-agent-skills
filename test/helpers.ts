import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { CliContext } from '../src/commands/context';
import type { Tty } from '../src/shared/prompt';

export function tmp(prefix = 'social-skills-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function write(path: string, content: string | Buffer): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

export function fakeTty(answers: string[] = [], interactive = true): Tty & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    isInteractive: () => interactive,
    async ask(question) {
      asked.push(question);
      return answers.shift() ?? '';
    },
  };
}

export interface TestContext extends CliContext {
  stdout: string[];
  stderr: string[];
}

export function testContext(overrides: Partial<CliContext> = {}): TestContext {
  const root = tmp();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const home = join(root, 'home');
  const cwd = join(root, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  return {
    cwd,
    home,
    env: { PATH: '', SOCIAL_SKILLS_CONFIG_DIR: join(root, 'config') },
    tty: fakeTty([], false),
    out: (line) => stdout.push(line),
    err: (line) => stderr.push(line),
    skillsRoot: join(import.meta.dirname, '..', 'skills'),
    packageName: 'social-agent-skills',
    version: '0.1.0',
    stdout,
    stderr,
    ...overrides,
  };
}

/** Minimal valid PNG header with the given dimensions. */
export function pngHeader(width: number, height: number): Buffer {
  const buf = Buffer.alloc(33);
  buf.writeUInt32BE(0x89504e47, 0);
  buf.writeUInt32BE(0x0d0a1a0a, 4);
  buf.writeUInt32BE(13, 8);
  buf.write('IHDR', 12, 'ascii');
  buf.writeUInt32BE(width, 16);
  buf.writeUInt32BE(height, 20);
  return buf;
}
