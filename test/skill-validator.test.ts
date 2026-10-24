import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateFrontmatter, validateSkillDir } from '../src/core/skill-validator';
import { tmp, write } from './helpers';

describe('validateFrontmatter (agentskills.io spec)', () => {
  const valid = { name: 'pdf-processing', description: 'Extract PDF text. Use when handling PDFs.' };

  it('accepts the spec examples', () => {
    expect(validateFrontmatter(valid, 'pdf-processing')).toEqual([]);
    expect(
      validateFrontmatter(
        { ...valid, license: 'Apache-2.0', metadata: { author: 'example-org', version: '1.0' } },
        'pdf-processing',
      ),
    ).toEqual([]);
  });

  it.each([
    ['PDF-Processing', /lowercase/],
    ['-pdf', /must not start or end/],
    ['pdf-', /must not start or end/],
    ['pdf--processing', /single hyphens/],
    ['a'.repeat(65), /exceeds 64/],
  ])('rejects name %s', (name, pattern) => {
    const errors = validateFrontmatter({ ...valid, name }, name);
    expect(errors.join('\n')).toMatch(pattern);
  });

  it('requires name to match the directory', () => {
    expect(validateFrontmatter(valid, 'other')).toEqual([expect.stringMatching(/must match the directory/)]);
  });

  it('enforces description and compatibility limits', () => {
    expect(validateFrontmatter({ ...valid, description: '' }, 'pdf-processing')).toHaveLength(1);
    expect(validateFrontmatter({ ...valid, description: 'x'.repeat(1025) }, 'pdf-processing')).toHaveLength(1);
    expect(validateFrontmatter({ ...valid, compatibility: 'x'.repeat(501) }, 'pdf-processing')).toHaveLength(1);
  });

  it('requires metadata values to be strings', () => {
    expect(validateFrontmatter({ ...valid, metadata: { version: 1 } }, 'pdf-processing')).toEqual([
      '"metadata.version" must be a string',
    ]);
  });

  it('rejects fields outside the spec so skills stay portable', () => {
    expect(validateFrontmatter({ ...valid, 'disable-model-invocation': true }, 'pdf-processing')).toEqual([
      expect.stringMatching(/unknown frontmatter field "disable-model-invocation"/),
    ]);
  });
});

describe('validateSkillDir', () => {
  function skill(body: string, frontmatter = 'name: demo\ndescription: Demo skill. Use for tests.') {
    const dir = join(tmp(), 'demo');
    write(join(dir, 'SKILL.md'), `---\n${frontmatter}\n---\n${body}`);
    return dir;
  }

  it('flags agent-specific tool wording', () => {
    expect(validateSkillDir(skill('Use the Bash tool to run it.')).join()).toMatch(/agent-specific wording/);
  });

  it('flags missing linked files and node script paths', () => {
    const errors = validateSkillDir(skill('See [ref](references/x.md) and run `node scripts/run.mjs`.'));
    expect(errors).toEqual([
      'referenced file not found: references/x.md',
      'referenced file not found: scripts/run.mjs',
    ]);
  });

  it('does not treat project paths as skill files', () => {
    expect(validateSkillDir(skill('Record the voiceover as `assets/voiceover.mp3`.'))).toEqual([]);
  });

  it('requires references/setup.md for platform skills', () => {
    const dir = skill('Body', 'name: demo\ndescription: Demo. Use for tests.\nmetadata:\n  platform: youtube');
    expect(validateSkillDir(dir)).toEqual(['platform skills must include references/setup.md']);
  });

  it('reports missing frontmatter', () => {
    const dir = join(tmp(), 'bare');
    write(join(dir, 'SKILL.md'), '# no frontmatter');
    expect(validateSkillDir(dir)[0]).toMatch(/must start with YAML frontmatter/);
  });
});
