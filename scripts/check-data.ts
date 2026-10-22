import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { changelogIndex } from '../src/changelog.js';
import { factionFromYaml, factionToYaml, metaFromYaml, metaToYaml } from '../src/emit.js';
import type { Faction, SiteMeta } from '../src/model.js';

/**
 * Check that the committed generated files are exactly what the tools would write (see
 * *Integrity of the committed files* in `specs/data-model.md`):
 *
 *   tsx scripts/check-data.ts
 *
 * Every `data/<slug>.yaml` must pass the `Faction` schema, be named after its slug and be
 * canonical; `data/meta.yaml` must pass `SiteMeta` and be canonical; and
 * `DATA-CHANGELOG.md` must be the index `changelogIndex()` generates from `changelog/`.
 * Canonical form catches a hand edit that breaks the writer's formatting, not a well-formed
 * one: keeping those out is CI's data-guard. `checkData()` is pure, files in and problems
 * out, so tests can hand it broken copies; the CLI reads the repository.
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
    const problem = f.name === 'meta.yaml' ? checkMeta(f.text) : checkFaction(f);
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

function checkFaction({ name, text }: TextFile): string | undefined {
  const path = `data/${name}`;
  let faction: Faction;
  try {
    faction = factionFromYaml(text);
  } catch (err) {
    return invalid(path, err);
  }
  if (name !== `${faction.slug}.yaml`) {
    return `${path} holds the slug "${faction.slug}", so it belongs in data/${faction.slug}.yaml`;
  }
  return canonical(path, text, factionToYaml(faction), 'factionToYaml()');
}

function checkMeta(text: string): string | undefined {
  const path = 'data/meta.yaml';
  let meta: SiteMeta;
  try {
    meta = metaFromYaml(text);
  } catch (err) {
    return invalid(path, err);
  }
  return canonical(path, text, metaToYaml(meta), 'metaToYaml()');
}

/** A file that doesn't parse, or fails its schema. */
function invalid(path: string, err: unknown): string {
  const detail = err instanceof z.ZodError ? z.prettifyError(err) : String(err);
  return `${path} is invalid:\n${detail.trimEnd().replace(/^(?=.)/gm, '  ')}`;
}

/** A problem if `text` isn't byte for byte what `writer` wrote for it (`written`). */
function canonical(
  path: string,
  text: string,
  written: string,
  writer: string,
): string | undefined {
  if (written === text) return undefined;
  return `${path} is not canonical: ${firstDifference(text, written, writer)}`;
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

// CLI: tsx scripts/check-data.ts — checks the repository this script lives in. Both paths
// are resolved through symlinks: a mismatch would skip the check and still exit 0.
const isMain =
  argv[1] !== undefined &&
  existsSync(argv[1]) &&
  realpathSync(argv[1]) === realpathSync(fileURLToPath(import.meta.url));
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
