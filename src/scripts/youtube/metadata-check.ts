import { resolve } from 'node:path';
import { checkMetadata } from '../../platforms/youtube/metadata';
import { readMetadata } from '../../platforms/youtube/pipeline';
import { printJson } from '../../shared/log';
import { requireFlag, runScript } from '../run';

const HELP = `
Usage: node scripts/metadata-check.mjs --dir <project-folder>

Validates <dir>/metadata.json against YouTube limits and prints a JSON report.
Exit code 0 when valid, 1 when there are errors. Warnings do not fail.

Checks:
  title          1-100 characters, no < or >
  description    up to 5000 bytes, no < or >
  tags           up to 500 characters as YouTube counts them, no commas
  madeForKids    must be true or false explicitly
  categoryId     numeric string
  thumbnail      PNG or JPEG, up to 2 MB, at least 640 px wide; 1280x720 recommended

Options:
  --dir <path>   project folder containing metadata.json (required)
  -h, --help     show this help
`;

runScript(HELP, { dir: { type: 'string' } }, (flags) => {
  const dir = resolve(requireFlag(flags, 'dir'));
  const report = checkMetadata(readMetadata(dir), dir);
  printJson(report);
  if (!report.ok) process.exitCode = 1;
});
