import { parse } from 'yaml';

export interface ParsedSkillFile {
  frontmatter: Record<string, unknown>;
  body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

export function parseSkillFile(source: string): ParsedSkillFile {
  const match = FRONTMATTER.exec(source);
  if (!match) {
    throw new Error('SKILL.md must start with YAML frontmatter delimited by --- lines');
  }
  const data: unknown = parse(match[1] ?? '');
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('SKILL.md frontmatter must be a YAML mapping');
  }
  return { frontmatter: data as Record<string, unknown>, body: match[2] ?? '' };
}

/** Space-separated list stored in a metadata string value, e.g. metadata.requires. */
export function metadataList(frontmatter: Record<string, unknown>, key: string): string[] {
  const metadata = frontmatter.metadata;
  if (!metadata || typeof metadata !== 'object') return [];
  const value = (metadata as Record<string, unknown>)[key];
  return typeof value === 'string' ? value.split(/\s+/).filter(Boolean) : [];
}
