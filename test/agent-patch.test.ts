import { execFileSync, spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  addPages,
  applyPatch,
  assessRisk,
  BODY_LIMIT,
  checkPatch,
  cleanNotes,
  disallowed,
  fence,
  freePages,
  MAX_FILES,
  MAX_PATCH_BYTES,
  main,
  type PatchLines,
  PatchRejected,
  pagesNamed,
  prBody,
  type RiskInput,
  readMeta,
  readPatch,
} from '../src/ops/agent-patch.js';
import { expectNodeOnly } from './node-only.js';

/**
 * The drift fixer's patch check (src/ops/agent-patch.ts): the one thing between a model
 * that read the live site and a PR opened with the App's token.
 */

const scratch = mkdtempSync(join(tmpdir(), 'agent-patch-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const BASE: Record<string, string> = {
  'src/parse.ts': 'export const a = 1;\nexport const b = 2;\n',
  'src/old-name.ts': 'export const c = 3;\n',
  'specs/scraping.md': '# Scraping\n\nThe footer is chrome.\n',
  'test/parse.test.ts': "it('parses', () => {});\n",
  'test/fixtures/necrons.html': '<html><body>v1.1</body></html>\n',
  'docs/decisions/0001-x.md': '# 0001\n',
  'data/necrons.yaml': 'slug: necrons\n',
  'package.json': '{ "scripts": { "verify": "vitest" } }\n',
  '.github/workflows/ci.yml': 'name: CI\n',
};

let repos = 0;
const run = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });

/** A fresh repository holding `BASE`, committed. */
function repo(): string {
  const dir = join(scratch, `repo-${repos++}`);
  mkdirSync(dir);
  run(dir, 'init', '-q', '-b', 'main');
  for (const [path, text] of Object.entries(BASE)) write(dir, path, text);
  run(dir, 'add', '-A');
  run(dir, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'base');
  return dir;
}

function write(dir: string, path: string, text: string) {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** The patch the agent's job would make after `edit`: new files too, as `git diff` shows them. */
function patchOf(edit: (dir: string) => void): string {
  const dir = repo();
  edit(dir);
  run(dir, 'add', '--intent-to-add', '--all');
  return run(dir, 'diff', '--no-ext-diff', '--no-textconv', 'HEAD');
}

const rejects = (patch: string, message: RegExp) => {
  expect(() => checkPatch(patch)).toThrow(PatchRejected);
  expect(() => checkPatch(patch)).toThrow(message);
};

describe('disallowed — where the agent may change files', () => {
  it.each([
    'src/parse/page.ts',
    'specs/scraping.md',
    'test/parse.test.ts',
    'test/__snapshots__/parse.test.ts.snap',
    'docs/decisions/0027-x.md',
  ])('allows %s', (path) => {
    expect(disallowed(path)).toBeUndefined();
  });

  it.each([
    ['data/necrons.yaml', /outside/],
    ['changelog/v1.6.md', /outside/],
    ['DATA-CHANGELOG.md', /outside/],
    ['package.json', /outside/],
    ['pnpm-lock.yaml', /outside/],
    ['.github/workflows/scrape.yml', /not a plain path/],
    ['.agents/skills/diagnose-parse/SKILL.md', /not a plain path/],
    ['docs/README.md', /outside/],
    ['test/fixtures/necrons.html', /saved page/],
    ['src/../data/necrons.yaml', /not a plain path/],
    ['src/./parse.ts', /not a plain path/],
    ['src/.gitattributes', /not a plain path/],
    ['/src/parse.ts', /not a plain path/],
    ['src//parse.ts', /not a plain path/],
    ['src/pa rse.ts', /not a plain path/],
    ['src/parse.ts\n', /not a plain path/],
    ['src\\parse.ts', /not a plain path/],
    ['src/*.ts', /not a plain path/],
    ['srcx/parse.ts', /outside/],
  ])('rejects %j', (path, why) => {
    expect(disallowed(path)).toMatch(why);
  });
});

describe('checkPatch — what git diff writes', () => {
  it('lists the changes the agent may make: edits, new files, deletions, renames', () => {
    const patch = patchOf((dir) => {
      write(dir, 'src/parse.ts', 'export const a = 1;\nexport const b = 3;\n');
      write(dir, 'test/drift.test.ts', "it('drops the footer', () => {});\n");
      unlinkSync(join(dir, 'docs/decisions/0001-x.md'));
      renameSync(join(dir, 'src/old-name.ts'), join(dir, 'src/new-name.ts'));
      write(dir, 'specs/empty.md', '');
    });
    expect(checkPatch(patch)).toEqual(
      expect.arrayContaining([
        { path: 'src/parse.ts', change: 'modify' },
        { path: 'test/drift.test.ts', change: 'add' },
        { path: 'docs/decisions/0001-x.md', change: 'delete' },
        { path: 'specs/empty.md', change: 'add' },
      ]),
    );
    // git pairs the moved file up as a rename, or lists a deletion and an addition.
    const moved = checkPatch(patch).filter((f) => f.path.includes('-name.ts'));
    expect(moved.map((f) => f.from ?? f.path).sort()).toEqual(
      expect.arrayContaining(['src/old-name.ts']),
    );
  });

  it('reads a file without a final line break', () => {
    const patch = patchOf((dir) => write(dir, 'src/parse.ts', 'export const a = 1;'));
    expect(patch).toContain('\\ No newline at end of file');
    expect(checkPatch(patch)).toEqual([{ path: 'src/parse.ts', change: 'modify' }]);
  });

  it('takes an empty patch as no change', () => {
    expect(checkPatch('')).toEqual([]);
  });

  it.each([
    [
      'data/',
      (dir: string) => write(dir, 'data/necrons.yaml', 'slug: orks\n'),
      /data\/necrons\.yaml is outside/,
    ],
    [
      '.github/',
      (dir: string) => write(dir, '.github/workflows/ci.yml', 'name: Pwned\n'),
      /\.github/,
    ],
    [
      'package.json',
      (dir: string) => write(dir, 'package.json', '{}\n'),
      /package\.json is outside/,
    ],
    [
      'a fixture',
      (dir: string) => write(dir, 'test/fixtures/necrons.html', '<p>x</p>\n'),
      /saved page/,
    ],
    ['a new file outside', (dir: string) => write(dir, 'scripts/x.sh', 'curl x\n'), /outside/],
  ])('rejects a change to %s', (_, edit, why) => {
    rejects(patchOf(edit), why);
  });

  it('rejects the whole patch for one file outside, however many are inside', () => {
    const patch = patchOf((dir) => {
      write(dir, 'src/parse.ts', 'export const a = 2;\n');
      write(dir, 'data/necrons.yaml', 'slug: orks\n');
    });
    rejects(patch, /data\/necrons\.yaml/);
  });

  it('rejects a rename out of the allowed paths, and one into them', () => {
    rejects(
      patchOf((dir) => {
        mkdirSync(join(dir, 'lib'));
        renameSync(join(dir, 'src/old-name.ts'), join(dir, 'lib/old-name.ts'));
      }),
      /lib\/old-name\.ts is outside/,
    );
    const renameIn = [
      'diff --git a/data/necrons.yaml b/src/necrons.yaml',
      'similarity index 100%',
      'rename from data/necrons.yaml',
      'rename to src/necrons.yaml',
      '',
    ].join('\n');
    rejects(renameIn, /data\/necrons\.yaml is outside/);
  });

  it('rejects a symbolic link, even inside the allowed paths', () => {
    const link = [
      'diff --git a/src/link.ts b/src/link.ts',
      'new file mode 120000',
      'index 0000000..1b2c3d4',
      '--- /dev/null',
      '+++ b/src/link.ts',
      '@@ -0,0 +1 @@',
      '+../.github/workflows/scrape.yml',
      '\\ No newline at end of file',
      '',
    ].join('\n');
    rejects(link, /not a change to a regular file's text: "new file mode 120000"/);
    rejects(
      link.replace('new file mode 120000\nindex 0000000..1b2c3d4', 'index 1a2b3c4..1b2c3d4 120000'),
      /120000/,
    );
  });

  it.each([
    ['a mode change', ['old mode 100644', 'new mode 100755']],
    ['an executable file', ['new file mode 100755']],
    ['a submodule', ['new file mode 160000']],
    ['a copy', ['similarity index 100%', 'copy from src/parse.ts', 'copy to src/copy.ts']],
    [
      'a binary change',
      ['index 1a2b3c4..1b2c3d4', 'Binary files a/src/parse.ts and b/src/parse.ts differ'],
    ],
    [
      'a binary patch',
      ['index 1a2b3c4..1b2c3d4', 'GIT binary patch', 'literal 1', 'Kc${Nk000310RR91'],
    ],
  ])('rejects %s', (_, headers) => {
    rejects(
      ['diff --git a/src/parse.ts b/src/parse.ts', ...headers, ''].join('\n'),
      /not a change to a regular file's text/,
    );
  });

  it('rejects a diff without a "diff --git" header, which git apply would still apply', () => {
    rejects(
      [
        '--- a/data/necrons.yaml',
        '+++ b/data/necrons.yaml',
        '@@ -1 +1 @@',
        '-slug: necrons',
        '+slug: orks',
        '',
      ].join('\n'),
      /line 1: expected a "diff --git" line/,
    );
  });

  it('rejects a second diff hidden after a hunk, where git apply would look for one', () => {
    const smuggled = [
      'diff --git a/src/parse.ts b/src/parse.ts',
      'index 1a2b3c4..1b2c3d4 100644',
      '--- a/src/parse.ts',
      '+++ b/src/parse.ts',
      '@@ -1 +1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      'trailing words git skips',
      '--- a/data/necrons.yaml',
      '+++ b/data/necrons.yaml',
      '@@ -1 +1 @@',
      '-slug: necrons',
      '+slug: orks',
      '',
    ].join('\n');
    rejects(smuggled, /line 8: expected a "diff --git" line/);
  });

  it('counts hunk lines as git does, so a short header cannot hide lines', () => {
    const overlong = [
      'diff --git a/src/parse.ts b/src/parse.ts',
      'index 1a2b3c4..1b2c3d4 100644',
      '--- a/src/parse.ts',
      '+++ b/src/parse.ts',
      '@@ -1 +1 @@',
      '-export const a = 1;',
      '+export const a = 2;',
      '+export const extra = 3;',
      '',
    ].join('\n');
    rejects(overlong, /line 8: expected a "diff --git" line/);
    const short = overlong.replace('@@ -1 +1 @@', '@@ -1,2 +1,3 @@');
    rejects(short, /the hunk ends early/);
  });

  it.each([
    [
      'a header naming another file than its --- line',
      'diff --git a/src/parse.ts b/src/parse.ts',
      '--- a/data/necrons.yaml',
      /expected "--- a\/src\/parse\.ts"/,
    ],
    [
      'two paths without a rename',
      'diff --git a/src/parse.ts b/src/other.ts',
      '--- a/src/parse.ts',
      /two paths, but no rename/,
    ],
    [
      'a quoted path',
      'diff --git "a/src/pa rse.ts" "b/src/pa rse.ts"',
      '--- a/src/parse.ts',
      /expected a "diff --git" line/,
    ],
  ])('rejects %s', (_, header, minus, why) => {
    rejects(
      [
        header,
        'index 1a2b3c4..1b2c3d4 100644',
        minus,
        '+++ b/src/parse.ts',
        '@@ -1 +1 @@',
        '-a',
        '+b',
        '',
      ].join('\n'),
      why,
    );
  });

  it('rejects the same file twice', () => {
    const once = patchOf((dir) => write(dir, 'src/parse.ts', 'export const a = 2;\n'));
    rejects(once + once, /src\/parse\.ts appears twice/);
  });

  it.each([
    ['the model key', 'sk-ant-api03-AbCdEfGhIjKlMnOp'],
    ['a GitHub token', `ghs_${'a'.repeat(36)}`],
    ['a fine-grained token', `github_pat_${'A1'.repeat(20)}`],
    ['a private key', '-----BEGIN RSA PRIVATE KEY-----'],
  ])('rejects a patch that adds %s', (_, secret) => {
    rejects(
      patchOf((dir) => write(dir, 'test/drift.test.ts', `const leak = '${secret}';\n`)),
      /line \d+: it adds something that looks like a credential/,
    );
  });

  it('rejects a patch too big to review, or not ending in a line break', () => {
    rejects(`diff --git a/src/a.ts b/src/a.ts\n${'+'.repeat(MAX_PATCH_BYTES)}\n`, /over \d+ bytes/);
    rejects('diff --git a/src/a.ts b/src/a.ts', /line break/);
  });
});

describe('applyPatch — the tree changes exactly where the patch says', () => {
  it('applies an allowed patch to a fresh checkout', () => {
    const patch = join(scratch, 'ok.patch');
    writeFileSync(
      patch,
      patchOf((dir) => {
        write(dir, 'src/parse.ts', 'export const a = 1;\nexport const b = 3;\n');
        write(dir, 'test/drift.test.ts', "it('drops the footer', () => {});\n");
      }),
    );
    const dir = repo();
    expect(applyPatch(dir, patch)).toEqual([
      { path: 'src/parse.ts', change: 'modify' },
      { path: 'test/drift.test.ts', change: 'add' },
    ]);
    expect(readFileSync(join(dir, 'src/parse.ts'), 'utf8')).toContain('b = 3');
  });

  it('rejects a checkout where anything else changed too', () => {
    const patch = join(scratch, 'ok2.patch');
    writeFileSync(
      patch,
      patchOf((dir) => write(dir, 'src/parse.ts', 'export const a = 9;\n')),
    );
    const dir = repo();
    write(dir, 'data/stray.yaml', 'x: 1\n');
    expect(() => applyPatch(dir, patch)).toThrow(/the patch changed data\/stray\.yaml too/);
  });

  it('applies nothing from a rejected patch', () => {
    const patch = join(scratch, 'bad.patch');
    writeFileSync(
      patch,
      patchOf((dir) => write(dir, 'data/necrons.yaml', 'slug: orks\n')),
    );
    const dir = repo();
    expect(() => applyPatch(dir, patch)).toThrow(PatchRejected);
    expect(run(dir, 'status', '--porcelain')).toBe('');
  });
});

describe('readPatch — the lines each file gains and loses', () => {
  it('collects each file’s added lines and counts its removed ones', () => {
    const { files, lines } = readPatch(
      patchOf((dir) => {
        write(
          dir,
          'src/parse.ts',
          'export const a = 1;\nexport const b = 3;\nexport const c = 4;\n',
        );
        write(dir, 'src/parse/cards.ts', 'const x = 1;\n');
      }),
    );
    expect(files.map((f) => f.path)).toEqual(['src/parse.ts', 'src/parse/cards.ts']);
    expect(lines.get('src/parse.ts')).toEqual({
      added: ['export const b = 3;', 'export const c = 4;'],
      removed: 1,
    });
    expect(lines.get('src/parse/cards.ts')).toEqual({ added: ['const x = 1;'], removed: 0 });
  });

  it('lists the same files as checkPatch', () => {
    const patch = patchOf((dir) => write(dir, 'specs/scraping.md', '# Scraping\n'));
    expect(readPatch(patch).files).toEqual(checkPatch(patch));
  });
});

describe('assessRisk — which fixes merge themselves (0040)', () => {
  const PAGE = 'orks-legends-cookie.html';
  /** A fix like #114's: the parser, its test reading the scrape's page, and the spec. */
  const fix = (dir: string) => {
    write(dir, 'src/parse/cards.ts', "const rows = 'li:not(.no-leaders)';\n");
    write(dir, 'test/parse.test.ts', `it('parses', () => {});\nfixture('${PAGE}');\n`);
    write(dir, 'specs/scraping.md', '# Scraping\n\nA grant is its own row.\n');
  };
  /** The fix, and one more file. */
  const also = (path: string, text: string) => (dir: string) => {
    fix(dir);
    write(dir, path, text);
  };
  const assess = (edit: (dir: string) => void, input: Partial<RiskInput> = {}) =>
    assessRisk({
      files: readPatch(patchOf(edit)).files,
      meta: { finished: true },
      notes: 'The site moved the grant into its own row.',
      ...input,
    });

  it('finds a parser fix with its page and its spec low risk', () => {
    expect(assess(fix)).toEqual({ low: true, reasons: [] });
  });

  // CI and the live smoke test check what the code does; the patch check bounds where it
  // goes. Nothing else holds a fix back (0040).
  it.each([
    ['src/ops/git.ts', 'const y = 2;\n'],
    ['test/__snapshots__/parse.test.ts.snap', 'exports[`a 1`] = `x`;\n'],
    ['docs/decisions/0001-x.md', '# 1\n'],
    ['specs/change-tracking.md', '# Change tracking\n'],
    ['src/parse/cards.ts', "import { load } from 'cheerio';\nconst p = process.env;\n"],
    ['src/parse/rows.ts', Array.from({ length: 400 }, (_, i) => `const v${i} = ${i};\n`).join('')],
  ])('takes any change the patch check allows: %s', (path, text) => {
    expect(assess(also(path, text))).toEqual({ low: true, reasons: [] });
  });

  it('takes a fix that adds no page from the scrape', () => {
    const noPage = (dir: string) => write(dir, 'src/parse/cards.ts', 'const rows = 1;\n');
    expect(assess(noPage)).toEqual({ low: true, reasons: [] });
  });

  // The smoke test runs only for a change under src/, and the scrape runs nothing else.
  it('finds a fix that changes nothing under src/ high risk', () => {
    expect(
      assess((dir) => write(dir, 'test/parse.test.ts', `fixture('${PAGE}');\n`)).reasons,
    ).toEqual(['it changes nothing under src/']);
  });

  it('finds an unfinished run, or one whose note asks for review, high risk', () => {
    expect(assess(fix, { meta: { finished: false } }).reasons).toEqual([
      'the agent did not finish',
    ]);
    expect(assess(fix, { notes: 'Needs review: unsure about Orks.\nThe rest.' }).reasons).toEqual([
      'the agent asked for review',
    ]);
  });
});

describe("the scrape's pages — the fixtures the PR adds, never the model's", () => {
  const PAGE = 'orks-legends-cookie.html';
  /** A drift artifact's fixtures directory holding `pages`. */
  const drift = (pages: Record<string, string | Buffer>) => {
    const dir = join(scratch, `drift-${repos++}`);
    mkdirSync(dir);
    for (const [name, html] of Object.entries(pages)) writeFileSync(join(dir, name), html);
    return dir;
  };

  it('offers only plain pages whose name is free in the checkout', () => {
    const dir = drift({
      [PAGE]: '<p>new</p>\n',
      'necrons.html': '<p>refreshed</p>\n', // repo() has test/fixtures/necrons.html
      'notes.txt': 'x\n',
      'Bad Name.html': 'x\n',
      'a.HTML': 'x\n',
    });
    mkdirSync(join(dir, 'folder.html'));
    try {
      symlinkSync(join(dir, PAGE), join(dir, 'link.html'));
    } catch {
      // Windows without the privilege: the link case just isn't exercised.
    }
    expect(freePages(dir, repo())).toEqual([PAGE]);
    expect(freePages(join(scratch, 'no-such-dir'), repo())).toEqual([]);
  });

  it('takes the pages an added line quotes by name, in any file, and no other', () => {
    const lines = new Map<string, PatchLines>([
      [
        'test/parse.test.ts',
        {
          added: [
            `const html = fixture('${PAGE}');`,
            // #114's test: it names the page it copied the markup from, and reads another.
            '// Markup from the refreshed y.html (TAKTIKAL BRIGADE)',
          ],
          removed: 0,
        },
      ],
      ['src/fixtures.ts', { added: ["  { name: 'x.html', url: factionUrl('x') },"], removed: 0 }],
      ['test/other.test.ts', { added: ["fixture('big-orks-legends-cookie.html');"], removed: 0 }],
    ]);
    expect(pagesNamed([PAGE, 'x.html', 'y.html'], lines)).toEqual([PAGE, 'x.html']);
  });

  it('copies a page byte for byte, and never over a fixture', () => {
    const bytes = Buffer.from('<p>Kill Kommanda\r\n“Waaagh!”</p>\n', 'utf8');
    const from = drift({ [PAGE]: bytes, 'necrons.html': '<p>refreshed</p>\n' });
    const dir = repo();
    addPages(from, dir, [PAGE]);
    expect(readFileSync(join(dir, 'test', 'fixtures', PAGE)).equals(bytes)).toBe(true);
    expect(() => addPages(from, dir, ['necrons.html'])).toThrow(PatchRejected);
    expect(readFileSync(join(dir, 'test', 'fixtures', 'necrons.html'), 'utf8')).toBe(
      BASE['test/fixtures/necrons.html'],
    );
  });

  describe('on the command line', () => {
    const fixPatch = (testLine: string) => {
      const patch = join(scratch, `fix-${repos++}.patch`);
      writeFileSync(
        patch,
        patchOf((dir) => {
          write(dir, 'src/parse/cards.ts', "const rows = 'li:not(.no-leaders)';\n");
          write(dir, 'test/parse.test.ts', `it('parses', () => {});\n${testLine}\n`);
        }),
      );
      return patch;
    };
    const runMain = (patch: string, extra: string[] = []) => {
      const dir = repo();
      const meta = join(scratch, 'meta.json');
      writeFileSync(meta, '{"finished": true}');
      const bodyFile = join(scratch, `body-${repos++}.md`);
      const output = join(scratch, `output-${repos++}`);
      const args = [dir, patch, '--scrape-run', '1', '--meta', meta, ...extra];
      const code = main([...args, '--body-file', bodyFile, '--output', output], {}, quiet);
      return {
        code,
        dir,
        output: readFileSync(output, 'utf8'),
        body: readFileSync(bodyFile, 'utf8'),
      };
    };

    it('adds the page the tests read and finds the fix low risk', () => {
      const pages = drift({ [PAGE]: '<p>new</p>\n' });
      const r = runMain(fixPatch(`fixture('${PAGE}');`), ['--drift', pages]);
      expect(r.code).toBe(0);
      expect(r.output).toBe(
        `changed=true\npaths=src/parse/cards.ts,test/parse.test.ts,test/fixtures/${PAGE}\nrisk=low\nreasons=\n`,
      );
      expect(readFileSync(join(r.dir, 'test', 'fixtures', PAGE), 'utf8')).toBe('<p>new</p>\n');
      expect(r.body).toContain('merges itself once CI and the live smoke test pass');
      expect(r.body).toContain(`- \`test/fixtures/${PAGE}\` (added from the scrape)`);
    });

    it('adds no page the patch does not name, and still finds the fix low risk', () => {
      const pages = drift({ [PAGE]: '<p>new</p>\n' });
      const r = runMain(fixPatch('const y = 1;'), ['--drift', pages]);
      expect(r.code).toBe(0);
      expect(r.output).toBe(
        'changed=true\npaths=src/parse/cards.ts,test/parse.test.ts\nrisk=low\nreasons=\n',
      );
      expect(r.body).not.toContain('test/fixtures/');
    });

    it('without the drift pages, adds none', () => {
      const r = runMain(fixPatch(`fixture('${PAGE}');`));
      expect(r.output).toBe(
        'changed=true\npaths=src/parse/cards.ts,test/parse.test.ts\nrisk=low\nreasons=\n',
      );
    });
  });
});

describe('the PR body', () => {
  const body = (notes: string, finished = true) =>
    prBody({
      files: [
        { path: 'src/parse.ts', change: 'modify' },
        { path: 'src/b.ts', change: 'rename', from: 'src/a.ts' },
      ],
      notes,
      meta: { turns: 17, costUsd: 1.234, finished },
      scrapeRunUrl: 'https://github.com/o/r/actions/runs/1',
      agentRunUrl: 'https://github.com/o/r/actions/runs/2',
      issue: 96,
      pages: [],
      risk: { low: false, reasons: ['the agent asked for review'] },
    });

  it('names the runs, the files, the cost, and what is left to do', () => {
    const text = body('The site added a footer.');
    expect(text).toContain(
      'after a scrape failed: https://github.com/o/r/actions/runs/1. Refs #96.',
    );
    expect(text).toContain('- `src/parse.ts` (changed)');
    expect(text).toContain('- `src/a.ts` → `src/b.ts` (renamed)');
    expect(text).toContain('```text\nThe site added a footer.\n```');
    expect(text).toContain('Agent run: https://github.com/o/r/actions/runs/2 · 17 turns · $1.23');
    expect(text).toContain('- [ ] Commit that page as the fixture');
    expect(text).not.toContain('did not finish');
  });

  it('asks for no page when one was added from the scrape', () => {
    const text = prBody({
      files: [{ path: 'src/parse/cards.ts', change: 'modify' }],
      notes: 'Fixed.',
      meta: { finished: true },
      scrapeRunUrl: 'https://github.com/o/r/actions/runs/1',
      agentRunUrl: 'https://github.com/o/r/actions/runs/2',
      pages: ['orks-legends-cookie.html'],
      risk: { low: false, reasons: ['it changes nothing under src/'] },
    });
    expect(text).toContain('> - it changes nothing under src/');
    expect(text).toContain('- `test/fixtures/orks-legends-cookie.html` (added from the scrape)');
    expect(text).not.toContain('Commit that page');
  });

  it('says so when the agent stopped short', () => {
    expect(body('', false)).toContain('> **The agent did not finish**');
    expect(body('', false)).toContain('```text\n(no note)\n```');
  });

  it("keeps the agent's note inside its code block, whatever it holds", () => {
    const note = 'Done.\n```\n@maintainer [click](https://evil.example) <img src=x>\n````';
    const text = body(note);
    expect(fence(note)).toBe('`````');
    expect(text).toContain(`\`\`\`\`\`text\n${note}\n\`\`\`\`\``);
  });

  it("stays under GitHub's body limit, whatever the note and the files", () => {
    const files = Array.from({ length: MAX_FILES }, (_, i) => ({
      path: `src/${String(i).padStart(2, '0')}${'x'.repeat(190)}.ts`,
      change: 'rename' as const,
      from: `src/${String(i).padStart(2, '0')}${'y'.repeat(190)}.ts`,
    }));
    // A long run of backticks lengthens the fence the note sits in, twice over.
    for (const notes of ['`'.repeat(19_000), `${'n'.repeat(19_000)}\n${'`'.repeat(800)}`]) {
      const body = prBody({
        files,
        notes,
        meta: { finished: true },
        scrapeRunUrl: 'https://github.com/o/r/actions/runs/1',
        agentRunUrl: 'https://github.com/o/r/actions/runs/2',
        pages: [],
        risk: { low: false, reasons: ['the agent asked for review'] },
      });
      expect(body.length).toBeLessThanOrEqual(BODY_LIMIT);
      expect(body).toContain('### Before it is ready');
    }
  });

  it('cleans and cuts the note', () => {
    expect(cleanNotes('a\u0000b\u001b[31mc\n\td ')).toBe('ab[31mc\n\td');
    expect(cleanNotes('x'.repeat(30_000))).toMatch(/^x{20000}\n\[… cut\]$/);
  });

  it('reads only plausible numbers from the run, and only a plain true as finished', () => {
    expect(readMeta('{"turns": 12, "cost": 0.5, "finished": true}')).toEqual({
      turns: 12,
      costUsd: 0.5,
      finished: true,
    });
    expect(readMeta('{"turns": "12", "cost": -1, "finished": "true"}')).toEqual({
      finished: false,
    });
    expect(readMeta('{}')).toEqual({ finished: false });
    expect(readMeta('not json')).toEqual({ finished: false });
  });
});

/** Discards what the command line prints. */
const quiet = { out: () => {}, err: () => {} };

describe('the command line', () => {
  it('applies, writes the body and the step outputs', () => {
    const patch = join(scratch, 'cli.patch');
    writeFileSync(
      patch,
      patchOf((dir) => write(dir, 'src/parse.ts', 'export const a = 5;\n')),
    );
    const notes = join(scratch, 'notes.md');
    writeFileSync(notes, 'Dropped the footer.');
    const dir = repo();
    const bodyFile = join(scratch, 'body.md');
    const output = join(scratch, 'output');
    const env = { GITHUB_REPOSITORY: 'o/r', GITHUB_RUN_ID: '2' };
    const args = [dir, patch, '--scrape-run', '1', '--issue', '96', '--notes', notes];
    expect(main([...args, '--body-file', bodyFile, '--output', output], env, quiet)).toBe(0);
    // No --meta: nothing says the agent finished.
    expect(readFileSync(output, 'utf8')).toBe(
      'changed=true\npaths=src/parse.ts\nrisk=high\nreasons=the agent did not finish\n',
    );
    expect(readFileSync(bodyFile, 'utf8')).toContain('Dropped the footer.');
  });

  it('exits 1 on a rejected patch, and on a note holding a credential', () => {
    const patch = join(scratch, 'cli-bad.patch');
    writeFileSync(
      patch,
      patchOf((dir) => write(dir, '.github/workflows/ci.yml', 'x\n')),
    );
    const bodyFile = join(scratch, 'body-bad.md');
    expect(main([repo(), patch, '--scrape-run', '1', '--body-file', bodyFile], {}, quiet)).toBe(1);
    const fine = join(scratch, 'cli-fine.patch');
    writeFileSync(fine, '');
    const notes = join(scratch, 'leaky.md');
    writeFileSync(notes, 'here: sk-ant-api03-0123456789abcdef');
    expect(
      main(
        [repo(), fine, '--scrape-run', '1', '--notes', notes, '--body-file', bodyFile],
        {},
        quiet,
      ),
    ).toBe(1);
  });

  it('refuses a malformed command line', () => {
    expect(main(['only-one'], {}, quiet)).toBe(2);
    expect(main(['a', 'b', '--scrape-run', 'x', '--body-file', 'f'], {}, quiet)).toBe(2);
    expect(
      main(['a', 'b', '--scrape-run', '1', '--issue', '9x', '--body-file', 'f'], {}, quiet),
    ).toBe(2);
  });
});

describe('it runs where the App key is: plain Node, no dependencies', () => {
  const file = fileURLToPath(new URL('../src/ops/agent-patch.ts', import.meta.url));
  const source = readFileSync(file, 'utf8');

  it("imports Node's own modules and nothing else", () => {
    expectNodeOnly(source);
  });

  it('runs under node --experimental-strip-types, outside the test runner', () => {
    const result = spawnSync(process.execPath, ['--experimental-strip-types', file, '--help'], {
      encoding: 'utf8',
    });
    expect(result.stderr.replace(/^.*ExperimentalWarning.*$\n?/gm, '')).not.toMatch(/Error/);
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(
      /^usage: node --experimental-strip-types src\/ops\/agent-patch\.ts/,
    );
  });
});
