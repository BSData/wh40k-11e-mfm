import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

/**
 * The agent layout (docs/decisions/0030-one-short-instruction-file.md): skills every
 * harness can load, and one short instruction file that names nothing that isn't there.
 */

const root = (path: string): string => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string): string => readFileSync(root(path), 'utf8');

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
  // Every line costs every task context, and long files are followed less well (0030).
  it('stays under 100 lines and 5,000 characters', () => {
    expect(agents.split('\n').length).toBeLessThan(100);
    expect(agents.length).toBeLessThanOrEqual(5000);
  });

  it('starts with the ground rules, then the definition of done', () => {
    const headings = [...agents.matchAll(/^## (.+)$/gm)].map((m) => m[1]);
    expect(headings.slice(0, 2)).toEqual(['Ground rules', 'Definition of done']);
  });

  // A path that no longer exists is how the old project map went stale.
  it('names only repository paths that exist', () => {
    const linked = [...agents.matchAll(/\]\(([^)#\s]+)\)/g)].map((m) => m[1] ?? '');
    const quoted = [...agents.matchAll(/`([^`\s]+)`/g)]
      .map((m) => m[1] ?? '')
      .filter((p) => /^[\w.-]+\/|^\.?[\w-]+\.(md|ts|ya?ml|json|html)$|\/$/.test(p));
    const paths = [...linked, ...quoted].filter(
      (p) => !/^https?:/.test(p) && !p.startsWith('/') && !/[<>*]/.test(p),
    );
    expect(paths.length).toBeGreaterThan(5);
    expect(paths.filter((p) => !existsSync(root(p.replace(/\/$/, ''))))).toEqual([]);
  });

  it('runs only pnpm scripts that exist', () => {
    const scripts = Object.keys(JSON.parse(read('package.json')).scripts ?? {});
    const used = [...agents.matchAll(/^pnpm ([\w:-]+)/gm)].map((m) => m[1] ?? '');
    expect(used.length).toBeGreaterThan(3);
    expect(used.filter((s) => s !== 'install' && !scripts.includes(s))).toEqual([]);
  });

  it('is what CLAUDE.md imports, and all it holds', () => {
    expect(read('CLAUDE.md').trim()).toBe('@AGENTS.md');
  });
});
