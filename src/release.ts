import { type Zippable, zipSync } from 'fflate';
import { ENTRIES_MARKER } from './changelog.js';
import { pointsCsv } from './csv.js';
import { factionDocument, metaDocument } from './emit.js';
import { type Dataset, type Faction, SCHEMA_VERSION, type SiteMeta } from './model.js';
import { jsonSchemas, REPO_URL } from './schema.js';

/**
 * A release of the dataset on `main` (see "Releases" in specs/data-model.md): its tag,
 * title and notes, read from the newest entry of the version's changelog file, and its
 * assets. `mfm release` reads the files and writes these out; the workflow publishes them
 * with `gh release create`. Pure: files in, release out.
 */

/** GitHub's limit on a release's notes, in characters. */
export const NOTES_LIMIT = 125_000;

/** A file of the release's input or output: its name and its bytes. */
export interface ReleaseFile {
  name: string;
  data: Uint8Array;
}

export interface Release {
  tag: string;
  title: string;
  notes: string;
  /** `all.json`, `points.csv`, the schemas and `data.zip`, in that order. */
  assets: ReleaseFile[];
}

/** A window's last day: `2026-10-05` for `2026-10-02 → 2026-10-05`. */
const lastDay = (window: string): string => window.split(' → ').at(-1) ?? '';

/**
 * The newest entry of a version's changelog file: its window (`[…]`), its label (what
 * follows ` — `: `MFM v1.6`, `Name casing`), its text, and its place among the entries
 * whose window ends the same day (`nth`: 1 for the first such entry, 2 for the second,
 * counting from the oldest).
 */
export function newestEntry(file: string): {
  window: string;
  label: string;
  text: string;
  nth: number;
} {
  const at = file.indexOf(ENTRIES_MARKER);
  const entries = at === -1 ? '' : file.slice(at + ENTRIES_MARKER.length);
  const headings = [...entries.matchAll(/^## \[([^\]\n]+)\](.*)$/gm)];
  const [heading] = headings;
  if (!heading || heading.index === undefined || !heading[1]) {
    throw new Error(`the changelog file has no entry under "${ENTRIES_MARKER}"`);
  }
  const window = heading[1];
  const rest = entries.slice(heading.index + heading[0].length);
  const next = rest.search(/^## \[/m);
  const text = `${heading[0]}${next === -1 ? rest : rest.slice(0, next)}`.trim();
  const nth = headings.filter((h) => lastDay(h[1] ?? '') === lastDay(window)).length;
  const label = (heading[2] ?? '').replace(/^\s*—\s*/, '').trim();
  return { window, label, text, nth };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const VERSION = /^\d+(?:\.\d+)*$/;

/**
 * `mfm-v<version>+<the window's last day>`: `mfm-v1.5+2026-10-05` for `2026-10-02 →
 * 2026-10-05`. The `nth` entry to end on the same day, from the second on, adds `.<nth>`
 * (`mfm-v1.6+2026-10-23.2`), so two entries never share a tag.
 */
export function releaseTag(version: string, window: string, nth = 1): string {
  if (!VERSION.test(version)) throw new Error(`not an MFM version for a tag: ${version}`);
  const last = lastDay(window);
  if (!DATE.test(last)) throw new Error(`the newest changelog entry is dated "${window}"`);
  if (!Number.isInteger(nth) || nth < 1) throw new Error(`not an entry's place: ${nth}`);
  return `mfm-v${version}+${last}${nth > 1 ? `.${nth}` : ''}`;
}

/** A Markdown link target that isn't absolute (`../specs/data-model.md`). */
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi;

/**
 * The release notes: the entry, with its relative links resolved against `fileUrl` (the
 * changelog file at the release's commit, since notes have no directory of their own), and
 * a footer with the schema version. An entry over GitHub's limit is replaced by a link to
 * the file.
 */
export function releaseNotes(entry: string, fileUrl: string): string {
  const resolved = entry.replace(
    RELATIVE_LINK,
    (_, href: string) => `](${new URL(href, fileUrl)})`,
  );
  const footer = [
    '---',
    '',
    `Data at \`schemaVersion\` ${SCHEMA_VERSION}. The assets (\`all.json\`, \`points.csv\`, the JSON ` +
      `Schemas and \`data.zip\`) are described in [Using the data](${REPO_URL}#using-the-data). ` +
      'Points from the Munitorum Field Manual (© Games Workshop). Unofficial: not affiliated with ' +
      'or endorsed by Games Workshop.',
  ].join('\n');
  const notes = `${resolved}\n\n${footer}\n`;
  if (notes.length <= NOTES_LIMIT) return notes;
  const heading = entry.split('\n', 1)[0] ?? '';
  const name = new URL(fileUrl).pathname.split('/').at(-1);
  return `${heading}\n\nThis entry is too long for release notes: read it in [${name}](${fileUrl}).\n\n${footer}\n`;
}

/** `all.json`: `meta.yaml` and every faction file, keys in the files' order, as one line. */
export function datasetJson(meta: SiteMeta, factions: Faction[]): string {
  const dataset: Dataset = {
    schemaVersion: meta.schemaVersion,
    meta: metaDocument(meta),
    factions: [...factions]
      .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
      .map((f) => factionDocument(f)),
  };
  return `${JSON.stringify(dataset)}\n`;
}

/**
 * `data.zip`: every file in `data/`, under `data/`, dated `lastUpdated`. Fixed dates and
 * order make it byte-identical for the same data. (fflate reads a date's local fields, so
 * the date is built in local time, which keeps it the same in every time zone.)
 */
export function dataZip(files: ReleaseFile[], lastUpdated: string): Uint8Array {
  const [y, m, d] = lastUpdated.split('-').map(Number);
  const mtime = new Date(y ?? 1980, (m ?? 1) - 1, d ?? 1);
  const entries: Zippable = {};
  for (const f of [...files].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    entries[`data/${f.name}`] = [f.data, { mtime }];
  }
  return zipSync(entries, { level: 9 });
}

const encoder = new TextEncoder();

/**
 * The release of a dataset: `meta` and `factions` as read from `data/` (`files`, every
 * file in it, for the zip), and `changelog`, the text of the version's changelog file,
 * which `changelogUrl` shows at the release's commit.
 */
export function buildRelease(input: {
  meta: SiteMeta;
  factions: Faction[];
  files: ReleaseFile[];
  changelog: string;
  changelogUrl: string;
}): Release {
  const { meta, factions } = input;
  const entry = newestEntry(input.changelog);
  // An update's entry is labelled with the version, which the title already gives.
  const name = `MFM v${meta.version}`;
  const label = entry.label && entry.label !== name ? `: ${entry.label}` : '';
  return {
    tag: releaseTag(meta.version, entry.window, entry.nth),
    title: `${name} — ${entry.window}${label}`,
    notes: releaseNotes(entry.text, input.changelogUrl),
    assets: [
      { name: 'all.json', data: encoder.encode(datasetJson(meta, factions)) },
      { name: 'points.csv', data: encoder.encode(pointsCsv(factions)) },
      ...jsonSchemas().map((s) => ({ name: s.name, data: encoder.encode(s.text) })),
      { name: 'data.zip', data: dataZip(input.files, meta.lastUpdated) },
    ],
  };
}
