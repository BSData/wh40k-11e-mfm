import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { changelogIndex } from './changelog.js';
import { POINTS_CSV, pointsCsv } from './csv.js';
import { factionFromYaml, factionToYaml, metaFromYaml, metaToYaml } from './emit.js';
import type { Faction, SiteMeta } from './model.js';
import { jsonSchemas } from './schema.js';

/**
 * Check that the committed generated files are exactly what the tools would write (see
 * *Integrity of the committed files* in `specs/data-model.md`):
 *
 *   pnpm check-data          (mfm check-data)
 *
 * Every `data/<slug>.yaml` must pass the `Faction` schema, be named after its slug and be
 * canonical; `data/meta.yaml` must pass `SiteMeta` (so it is at the current
 * `schemaVersion`) and be canonical; its `factions` must name exactly the faction files (a
 * slug with no `data/<slug>.yaml`, or a file whose slug it doesn't list, is a problem; by
 * file name, so a broken file still counts as there, and checked once `meta.yaml` passes
 * `SiteMeta`); `data/points.csv` must be what `pointsCsv()` makes of the faction files;
 * `schema/` must hold exactly the JSON Schemas `jsonSchemas()` generates; and
 * `DATA-CHANGELOG.md` must be the index `changelogIndex()` generates from `changelog/`.
 * Canonical form catches a hand edit that breaks the writer's formatting, not a well-formed
 * one: keeping those out is CI's data-guard. `checkData()` is pure, files in and problems
 * out, so tests can hand it broken copies; `readGeneratedFiles()` reads a repository.
 */

/** A file as `checkData()` sees it: its name within its directory, and its text. */
export interface TextFile {
  name: string;
  text: string;
}

/**
 * The generated files: `data/*.yaml`, `data/points.csv`, `schema/*`, `changelog/*`, and
 * `DATA-CHANGELOG.md`; `undefined` for a single file that is missing.
 */
export interface GeneratedFiles {
  data: TextFile[];
  points: string | undefined;
  schemas: TextFile[];
  changelog: TextFile[];
  index: string | undefined;
}

export const INDEX = 'DATA-CHANGELOG.md';

/** Every way the files differ from what the tools write, one message each; empty if none. */
export function checkData(files: GeneratedFiles): string[] {
  const problems: string[] = [];
  const factions: Faction[] = [];
  const factionFiles = files.data.filter((f) => f.name !== 'meta.yaml');
  let meta: SiteMeta | undefined;
  for (const f of files.data) {
    if (f.name === 'meta.yaml') {
      const checked = checkMeta(f.text);
      meta = checked.meta;
      if (checked.problem) problems.push(checked.problem);
    } else {
      const problem = checkFaction(f, factions);
      if (problem) problems.push(problem);
    }
  }
  if (!files.data.some((f) => f.name === 'meta.yaml')) problems.push('data/meta.yaml is missing');
  if (meta) problems.push(...checkFactionList(meta, factionFiles));

  // Only once every faction file is sound: the table is made from them, and a broken one
  // is already reported.
  const path = `data/${POINTS_CSV}`;
  if (files.points === undefined) problems.push(`${path} is missing`);
  else if (factions.length === factionFiles.length) {
    const problem = canonical(path, files.points, pointsCsv(factions), 'pointsCsv()');
    if (problem) problems.push(`${problem} (the faction files are the source; rescrape)`);
  }

  problems.push(...checkSchemas(files.schemas));

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

/** A faction file's problem, if any; a file without one is added to `sound`. */
function checkFaction({ name, text }: TextFile, sound: Faction[]): string | undefined {
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
  const problem = canonical(path, text, factionToYaml(faction), 'factionToYaml()');
  if (!problem) sound.push(faction);
  return problem;
}

/** `schema/` against `jsonSchemas()`: each file present and current, and no others. */
function checkSchemas(committed: TextFile[]): string[] {
  const problems: string[] = [];
  const fix = 'regenerate it with `pnpm mfm schema`';
  const generated = jsonSchemas();
  for (const g of generated) {
    const path = `schema/${g.name}`;
    const file = committed.find((f) => f.name === g.name);
    if (!file) problems.push(`${path} is missing: ${fix}`);
    else {
      const problem = canonical(path, file.text, g.text, 'jsonSchemas()');
      if (problem) problems.push(`${problem}; it is out of date with src/model.ts: ${fix}`);
    }
  }
  for (const f of committed) {
    if (!generated.some((g) => g.name === f.name)) {
      problems.push(`schema/${f.name} isn't generated from the model: delete it`);
    }
  }
  return problems;
}

/** `meta.yaml`'s problem, if any; `meta` once it passes `SiteMeta`, canonical or not. */
function checkMeta(text: string): { problem?: string | undefined; meta?: SiteMeta } {
  const path = 'data/meta.yaml';
  let meta: SiteMeta;
  try {
    meta = metaFromYaml(text);
  } catch (err) {
    return { problem: invalid(path, err) };
  }
  return { problem: canonical(path, text, metaToYaml(meta), 'metaToYaml()'), meta };
}

/**
 * `meta.yaml`'s `factions` against the faction files, by file name, so a file that is
 * broken still counts as there: a slug with no file, then a file whose slug isn't listed.
 */
function checkFactionList(meta: SiteMeta, factionFiles: TextFile[]): string[] {
  const problems: string[] = [];
  const slugs = factionFiles.map((f) => f.name.replace(/\.yaml$/, ''));
  for (const slug of meta.factions) {
    if (!slugs.includes(slug)) {
      problems.push(
        `data/meta.yaml lists "${slug}" in factions, but there is no data/${slug}.yaml`,
      );
    }
  }
  for (const slug of slugs) {
    if (!meta.factions.includes(slug)) {
      problems.push(`data/${slug}.yaml isn't in data/meta.yaml's factions`);
    }
  }
  return problems;
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

/** A file's text, or `undefined` when it doesn't exist. */
const readIfThere = (path: string) => (existsSync(path) ? readFileSync(path, 'utf8') : undefined);

/** A repository's generated files, as `checkData()` takes them. */
export function readGeneratedFiles(root: string): GeneratedFiles {
  return {
    data: readFiles(join(root, 'data'), '.yaml'),
    points: readIfThere(join(root, 'data', POINTS_CSV)),
    schemas: readFiles(join(root, 'schema')),
    changelog: readFiles(join(root, 'changelog')),
    index: readIfThere(join(root, INDEX)),
  };
}
