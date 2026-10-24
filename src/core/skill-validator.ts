import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { metadataList, parseSkillFile } from './frontmatter';

// Rules from the Agent Skills specification: https://agentskills.io/specification
const SPEC_FIELDS = new Set(['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools']);
export const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_NAME = 64;
const MAX_DESCRIPTION = 1024;
const MAX_COMPATIBILITY = 500;
const MAX_BODY_LINES = 500;

// Project rules on top of the spec: agent-neutral wording and a setup guide for platform skills.
const AGENT_SPECIFIC_WORDING =
  /\b(Bash|Read|Write|Edit|Grep|Glob|WebFetch|WebSearch|Task)\s+tool\b|\bClaude Code\b|\bCodex\b|\bGemini CLI\b|\bCopilot\b|\bCursor\b/;
// Markdown links into the skill and `node scripts/...` commands must resolve inside the skill.
// Bare paths like assets/voiceover.mp3 refer to the user's project folder and are not checked.
const RELATIVE_FILE_REF = /\]\(((?:scripts|references|assets)\/[^)\s#]+)\)|\bnode\s+(scripts\/[\w./-]+)/g;

export interface ValidationIssue {
  skill: string;
  message: string;
}

export function validateFrontmatter(frontmatter: Record<string, unknown>, dirName: string): string[] {
  const errors: string[] = [];

  for (const key of Object.keys(frontmatter)) {
    if (!SPEC_FIELDS.has(key)) {
      errors.push(`unknown frontmatter field "${key}" (spec allows: ${[...SPEC_FIELDS].join(', ')})`);
    }
  }

  const { name, description, license, compatibility, metadata } = frontmatter;
  const allowedTools = frontmatter['allowed-tools'];

  if (typeof name !== 'string' || name.length === 0) {
    errors.push('"name" is required and must be a non-empty string');
  } else {
    if (name.length > MAX_NAME) errors.push(`"name" exceeds ${MAX_NAME} characters`);
    if (!NAME_PATTERN.test(name)) {
      errors.push(
        '"name" may only contain lowercase letters, digits and single hyphens, and must not start or end with a hyphen',
      );
    }
    if (name !== dirName) errors.push(`"name" (${name}) must match the directory name (${dirName})`);
  }

  if (typeof description !== 'string' || description.trim().length === 0) {
    errors.push('"description" is required and must be a non-empty string');
  } else if (description.length > MAX_DESCRIPTION) {
    errors.push(`"description" exceeds ${MAX_DESCRIPTION} characters (${description.length})`);
  }

  if (license !== undefined && typeof license !== 'string') {
    errors.push('"license" must be a string');
  }

  if (compatibility !== undefined) {
    if (typeof compatibility !== 'string' || compatibility.length === 0) {
      errors.push('"compatibility" must be a non-empty string');
    } else if (compatibility.length > MAX_COMPATIBILITY) {
      errors.push(`"compatibility" exceeds ${MAX_COMPATIBILITY} characters`);
    }
  }

  if (metadata !== undefined) {
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
      errors.push('"metadata" must be a mapping of string keys to string values');
    } else {
      for (const [key, value] of Object.entries(metadata)) {
        if (typeof value !== 'string') errors.push(`"metadata.${key}" must be a string`);
      }
    }
  }

  if (allowedTools !== undefined && typeof allowedTools !== 'string') {
    errors.push('"allowed-tools" must be a space-separated string');
  }

  return errors;
}

/** Validates one skill directory against the spec and the project authoring rules. */
export function validateSkillDir(skillDir: string): string[] {
  const dirName = basename(skillDir);
  const skillFile = join(skillDir, 'SKILL.md');
  if (!existsSync(skillFile)) return ['missing SKILL.md'];

  const source = readFileSync(skillFile, 'utf8');
  let parsed: ReturnType<typeof parseSkillFile>;
  try {
    parsed = parseSkillFile(source);
  } catch (error) {
    return [(error as Error).message];
  }

  const errors = validateFrontmatter(parsed.frontmatter, dirName);

  if (source.split('\n').length > MAX_BODY_LINES) {
    errors.push(`SKILL.md exceeds ${MAX_BODY_LINES} lines; move detail into references/`);
  }

  const wording = AGENT_SPECIFIC_WORDING.exec(parsed.body);
  if (wording) {
    errors.push(`agent-specific wording "${wording[0]}" in SKILL.md body; keep instructions agent-neutral`);
  }

  for (const match of parsed.body.matchAll(RELATIVE_FILE_REF)) {
    const ref = (match[1] ?? match[2]) as string;
    if (!existsSync(join(skillDir, ref))) errors.push(`referenced file not found: ${ref}`);
  }

  for (const required of metadataList(parsed.frontmatter, 'requires')) {
    if (!existsSync(join(skillDir, '..', required, 'SKILL.md'))) {
      errors.push(`metadata.requires names "${required}", which is not a sibling skill`);
    }
  }

  if (metadataList(parsed.frontmatter, 'platform').length > 0) {
    const setup = join(skillDir, 'references', 'setup.md');
    if (!existsSync(setup) || statSync(setup).size === 0) {
      errors.push('platform skills must include references/setup.md');
    }
  }

  return errors;
}
