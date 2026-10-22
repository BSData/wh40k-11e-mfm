import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The agent layout (see "Harness files" in AGENTS.md): skills every harness can load, and
 * one instruction file that stays readable where harnesses truncate it.
 */

const read = (path: string): string =>
  readFileSync(fileURLToPath(new URL(`../${path}`, import.meta.url)), 'utf8');

const SKILLS_DIR = fileURLToPath(new URL('../.agents/skills', import.meta.url));
const skills = readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name);

/** The YAML block between a file's opening `---` line and the next one. */
function frontmatter(text: string): { name?: unknown; description?: unknown } {
  const block = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!block) throw new Error('no frontmatter: the file must start with a --- line');
  return parse(block[1] ?? '') ?? {};
}

const agents = read('AGENTS.md');

describe('skills (.agents/skills/<name>/SKILL.md)', () => {
  it('finds the skills', () => {
    expect(skills.length).toBeGreaterThan(0);
  });

  // https://agentskills.io/specification
  describe.each(skills)('%s', (dir) => {
    const meta = frontmatter(read(`.agents/skills/${dir}/SKILL.md`));

    it('is named after its folder, in lower-case words joined by hyphens', () => {
      expect(meta.name).toBe(dir);
      expect(dir).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(dir.length).toBeLessThanOrEqual(64);
    });

    it('says when to use it in at most 1,024 characters', () => {
      expect(typeof meta.description).toBe('string');
      const description = String(meta.description);
      expect(description.trim()).not.toBe('');
      expect(description.length).toBeLessThanOrEqual(1024);
    });

    it('is listed in the AGENTS.md skills index', () => {
      expect(agents).toContain(`(.agents/skills/${dir}/SKILL.md)`);
    });
  });
});

describe('AGENTS.md', () => {
  it('stays under 200 lines', () => {
    expect(agents.split('\n').length).toBeLessThan(200);
  });

  // Copilot code review reads only the first 4,000 characters of an instruction file.
  it.each(['## Ground rules', '## Definition of done'])(
    'ends "%s" within 4,000 characters',
    (heading) => {
      const start = agents.indexOf(heading);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = agents.indexOf('\n## ', start + heading.length);
      expect(end).toBeGreaterThan(start);
      expect(end).toBeLessThanOrEqual(4000);
    },
  );

  it('is what CLAUDE.md imports, and all it holds', () => {
    expect(read('CLAUDE.md').trim()).toBe('@AGENTS.md');
  });
});
