import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { changelogIndex } from '../src/changelog.js';
import { factionFromYaml, factionToYaml, metaFromYaml, metaToYaml } from '../src/emit.js';

/**
 * Check that the committed generated files are exactly what the tools would write (see
 * *Integrity of the committed files* in `specs/data-model.md`):
 *
 *   tsx scripts/check-data.ts
 *
 * Every `data/<slug>.yaml` must pass the `Faction` schema and be canonical,
 * `data/meta.yaml` must pass `SiteMeta` and be canonical, and `DATA-CHANGELOG.md` must be
 * the index `changelogIndex()` generates from `changelog/`. `checkData()` is pure, files
 * in and problems out, so tests can hand it broken copies; the CLI reads the repository.
 */

/** A file as `checkData()` sees it: its name within its directory, and its text. */
export interface TextFile {
  name: string;
  text: string;
}

/** The generated files: `data/*.yaml`, `changelog/*`, and `DATA-CHANGELOG.md` if present. */
export interface GeneratedFiles {
  data: TextFile[];
  changelog: TextFile[];
  index: string | undefined;
}

const INDEX = 'DATA-CHANGELOG.md';

/** Every way the files differ from what the tools write, one message each; empty if none. */
export function checkData(files: GeneratedFiles): string[] {
  const problems: string[] = [];
  for (const f of files.data) {
    const path = `data/${f.name}`;
    const problem =
      f.name === 'meta.yaml'
        ? roundTrip(path, f.text, 'metaToYaml()', (t) => metaToYaml(metaFromYaml(t)))
        : roundTrip(path, f.text, 'factionToYaml()', (t) => factionToYaml(factionFromYaml(t)));
    if (problem) problems.push(problem);
  }
  if (!files.data.some((f) => f.name === 'meta.yaml')) problems.push('data/meta.yaml is missing');

  if (files.index === undefined) {
    problems.push(`${INDEX} is missing`);
  } else {
    const index = changelogIndex(files.changelog);
    if (index !== files.index) {
      problems.push(
        `${INDEX} is out of date with changelog/: ${firstDifference(files.index, index, 'changelogIndex()')}`,
      );
    }
  }
  return problems;
}

/** Read `text` and write it back with `rewrite`; a problem if it fails or comes out changed. */
function roundTrip(
  path: string,
  text: string,
  writer: string,
  rewrite: (text: string) => string,
): string | undefined {
  let canonical: string;
  try {
    canonical = rewrite(text);
  } catch (err) {
    const detail = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
    return `${path} is invalid:\n${detail.trimEnd().replace(/^(?=.)/gm, '  ')}`;
  }
  if (canonical === text) return undefined;
  return `${path} is not canonical: ${firstDifference(text, canonical, writer)}`;
}

/** The first line where `actual` departs from what `writer` produced. */
function firstDifference(actual: string, expected: string, writer: string): string {
  const a = lines(actual);
  const e = lines(expected);
  const end = Math.max(a.length, e.length);
  let n = 0;
  while (n < end && a[n] === e[n]) n++;
  if (n === end) return `only the final newline differs from what ${writer} writes`;
  const show = (line: string | undefined) =>
    line === undefined ? 'the end of the file' : JSON.stringify(line);
  return `line ${n + 1} is ${show(a[n])} where ${writer} writes ${show(e[n])}`;
}

/** A file's lines, without the empty one `split` finds after a final newline. */
const lines = (text: string) => text.replace(/\n$/, '').split('\n');

/** The files in `dir` (none if it doesn't exist), optionally only those ending in `ext`. */
function readFiles(dir: string, ext = ''): TextFile[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.endsWith(ext))
    .map((d) => ({ name: d.name, text: readFileSync(join(dir, d.name), 'utf8') }))
    .sort((x, y) => (x.name < y.name ? -1 : 1));
}

// CLI: tsx scripts/check-data.ts — checks the repository this script lives in.
const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const indexPath = join(root, INDEX);
  const files: GeneratedFiles = {
    data: readFiles(join(root, 'data'), '.yaml'),
    changelog: readFiles(join(root, 'changelog')),
    index: existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : undefined,
  };
  const problems = checkData(files);
  if (problems.length === 0) {
    const factions = files.data.filter((f) => f.name !== 'meta.yaml').length;
    console.log(`check-data: ${factions} faction files, meta.yaml and ${INDEX} are canonical.`);
  } else {
    for (const p of problems) console.error(`✗ ${p}\n`);
    console.error(
      `check-data: ${problems.length} problem${problems.length === 1 ? '' : 's'}. These files are ` +
        'generated by the scraper; see "Integrity of the committed files" in specs/data-model.md.',
    );
    process.exitCode = 1;
  }
}
