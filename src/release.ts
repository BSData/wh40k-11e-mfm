import { type Zippable, zipSync } from 'fflate';
import { ENTRIES_MARKER } from './changelog.js';
import { POINTS_CSV, pointsCsv } from './csv.js';
import { factionDocument, factionToYaml, metaDocument, metaToYaml } from './emit.js';
import { fieldsUsed, type HistoryEntry, namesCasedOtherwise, type Snapshot } from './history.js';
import { type Dataset, type Faction, SCHEMA_VERSION, type SiteMeta } from './model.js';
import { nameCase } from './parse/names.js';
import { jsonSchemas, REPO_URL } from './schema.js';

/**
 * A release of the dataset (see "Releases" in specs/data-model.md): its tag, title and
 * notes, and its assets. The current release is named by the newest entry of the
 * version's changelog file; a past one, by its row in the history table
 * (`src/history.ts`). `mfm release` reads the files and writes these out; the workflow
 * publishes them with `gh release create`. Pure: data in, release out.
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

/** An entry of a version's changelog file. */
export interface Entry {
  /** Its heading line, `## [2026-10-22] — MFM v1.6`. */
  heading: string;
  /** What the brackets hold: `2026-10-22`, or `2026-10-02 → 2026-10-05`. */
  window: string;
  /** What follows ` — `: `MFM v1.6`, `Name casing`. */
  label: string;
  /** The heading and its body. */
  text: string;
}

/** A changelog file's entries, newest first, as the file lists them. */
export function entriesOf(file: string): Entry[] {
  const at = file.indexOf(ENTRIES_MARKER);
  const body = at === -1 ? '' : file.slice(at + ENTRIES_MARKER.length);
  const headings = [...body.matchAll(/^## \[([^\]\n]+)\](.*)$/gm)];
  return headings.map((h, i) => {
    const end = headings[i + 1]?.index ?? body.length;
    return {
      heading: h[0],
      window: h[1] ?? '',
      label: (h[2] ?? '').replace(/^\s*—\s*/, '').trim(),
      text: body.slice(h.index, end).trim(),
    };
  });
}

/**
 * The newest entry of a version's changelog file, and its place among the entries whose
 * window ends the same day (`nth`: 1 for the first such entry, 2 for the second, counting
 * from the oldest).
 */
export function newestEntry(file: string): Entry & { nth: number } {
  const entries = entriesOf(file);
  const [newest] = entries;
  if (!newest) throw new Error(`the changelog file has no entry under "${ENTRIES_MARKER}"`);
  const nth = entries.filter((e) => lastDay(e.window) === lastDay(newest.window)).length;
  return { ...newest, nth };
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

/** Numeric version order: v1.10 after v1.9. */
const byVersion = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
};

/**
 * The release before the current one: the entry just older than the newest entry of
 * `version`'s file, in all the changelog files (`files`, by version), and its tag: its
 * history row's, when it has one, or else the counting rule's. `undefined` when the current
 * entry is the first. A run checks it is published, so a release whose run failed or was
 * cancelled can't be skipped over.
 */
export function previousRelease(
  files: { version: string; text: string }[],
  history: Pick<HistoryEntry, 'tag' | 'version' | 'entries'>[],
  version: string,
): { heading: string; tag: string } | undefined {
  // Oldest first, across the versions.
  const all = [...files]
    .filter((f) => byVersion(f.version, version) <= 0)
    .sort((a, b) => byVersion(a.version, b.version))
    .flatMap((f) => {
      const entries = entriesOf(f.text);
      return entries
        .map((e, i) => ({ ...e, version: f.version, older: entries.slice(i + 1) }))
        .reverse();
    });
  const previous = all.at(-2);
  if (!previous) return undefined;
  const row = history.find(
    (h) => h.version === previous.version && h.entries.includes(previous.heading),
  );
  if (row) return { heading: previous.heading, tag: row.tag };
  const sameDay = previous.older.filter((e) => lastDay(e.window) === lastDay(previous.window));
  return {
    heading: previous.heading,
    tag: releaseTag(previous.version, previous.window, 1 + sameDay.length),
  };
}

/** `MFM v<version> — <window>`, and the entry's label when it isn't the version. */
export function releaseTitle(version: string, entry: Pick<Entry, 'window' | 'label'>): string {
  const name = `MFM v${version}`;
  // An update's entry is labelled with the version, which the title already gives.
  const label = entry.label && entry.label !== name ? `: ${entry.label}` : '';
  return `${name} — ${entry.window}${label}`;
}

/** A Markdown link target that isn't absolute (`../specs/data-model.md`). */
const RELATIVE_LINK = /\]\((?![a-z][a-z0-9+.-]*:|#)([^)\s]+)\)/gi;

/**
 * The release notes: the entry, with its relative links resolved against `fileUrl` (the
 * changelog file at the release's commit, since notes have no directory of their own),
 * then `extra` when there is any, and a footer with the schema version. An entry over
 * GitHub's limit is replaced by a link to the file.
 */
export function releaseNotes(entry: string, fileUrl: string, extra = ''): string {
  const resolved = entry.replace(
    RELATIVE_LINK,
    (_, href: string) => `](${new URL(href, fileUrl)})`,
  );
  const footer = [
    ...(extra ? [extra.trim(), ''] : []),
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
 * `data/` as the tools write it for a snapshot: each faction file, `meta.yaml` and
 * `points.csv`. For the committed data this is the committed files byte for byte (that is
 * what `mfm check-data` checks); for a past commit, its data in the current format.
 */
export function dataFiles({ meta, factions }: Snapshot): ReleaseFile[] {
  return [
    ...factions.map((f) => ({ name: `${f.slug}.yaml`, data: encoder.encode(factionToYaml(f)) })),
    { name: 'meta.yaml', data: encoder.encode(metaToYaml(meta)) },
    { name: POINTS_CSV, data: encoder.encode(pointsCsv(factions)) },
  ];
}

/** A snapshot's assets: `all.json`, `points.csv`, the schemas and `data.zip`. */
export function releaseAssets(snapshot: Snapshot): ReleaseFile[] {
  const { meta, factions } = snapshot;
  return [
    { name: 'all.json', data: encoder.encode(datasetJson(meta, factions)) },
    { name: 'points.csv', data: encoder.encode(pointsCsv(factions)) },
    ...jsonSchemas().map((s) => ({ name: s.name, data: encoder.encode(s.text) })),
    { name: 'data.zip', data: dataZip(dataFiles(snapshot), meta.lastUpdated) },
  ];
}

/**
 * The current release of a snapshot: named by `changelog`'s newest entry (the version's
 * changelog file, which `changelogUrl` shows at the release's commit).
 */
export function currentRelease(input: {
  snapshot: Snapshot;
  changelog: string;
  changelogUrl: string;
}): Release {
  const { meta } = input.snapshot;
  const entry = newestEntry(input.changelog);
  return {
    tag: releaseTag(meta.version, entry.window, entry.nth),
    title: releaseTitle(meta.version, entry),
    notes: releaseNotes(entry.text, input.changelogUrl),
    assets: releaseAssets(input.snapshot),
  };
}

/** `` `a`, `b` and `c` `` */
const list = (items: string[]) =>
  items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} and ${items.at(-1) as string}`;

/**
 * A past release, from its row in the history table: the notes are its changelog entries
 * (from `changelog`, the version's file, which `changelogUrl` shows), or the row's own
 * notes (`notesFile`: the text of its `notesFile`), then what a reader should know about a
 * backfilled snapshot. `fieldsNow` are the fields the current data uses, to name the ones
 * this snapshot doesn't have yet. `today` is the day it is backfilled on.
 */
export function historicalRelease(input: {
  entry: HistoryEntry;
  snapshot: Snapshot;
  changelog: string;
  changelogUrl: string;
  notesFile?: string;
  fieldsNow: Set<string>;
  today: string;
}): Release {
  const { entry, snapshot } = input;
  const date = entry.tag.match(/\+(\d{4}-\d{2}-\d{2})/)?.[1];
  if (snapshot.meta.version !== entry.version || snapshot.meta.lastUpdated !== date) {
    throw new Error(
      `${entry.tag}: ${entry.commit}'s meta.yaml says v${snapshot.meta.version}, last updated ` +
        `${snapshot.meta.lastUpdated}: the row's commit or tag is wrong`,
    );
  }
  const entries = entriesOf(input.changelog);
  const texts = entry.entries.map((heading) => {
    const found = entries.filter((e) => e.heading === heading);
    if (found.length !== 1) {
      throw new Error(`${entry.tag}: "${heading}" is in its changelog file ${found.length} times`);
    }
    return (found[0] as Entry).text;
  });
  const used = fieldsUsed(snapshot);
  const absent = [...input.fieldsNow].filter((f) => !used.has(f)).sort();
  const cased = namesCasedOtherwise(snapshot);
  const short = entry.commit.slice(0, 7);
  const from = `[\`${short}\`](${REPO_URL}/commit/${entry.commit})${entry.pr ? `, from #${entry.pr}` : ''}`;
  const facts = [
    ...(entry.schema1
      ? [
          "Converted from schema 1 with #41's mapping: a unit's `role` and `attachTo` became " +
            "`leaderTo` or `supportTo`, and a detachment's `objective` became `objectives`.",
        ]
      : []),
    ...(cased[0] !== undefined
      ? [
          `${cased.length} names are cased as they were before #88, such as \`${cased[0]}\` (now ` +
            `\`${nameCase(cased[0].toUpperCase())}\`): compare names upper-cased across releases.`,
        ]
      : []),
    ...(absent.length > 0
      ? [
          `Not in this snapshot yet, as later scrapes added them: ${list(absent.map((f) => `\`${f}\``))}.`,
        ]
      : []),
    ...(entry.caveats ?? []),
  ];
  const extra = [
    `**Backfilled** on ${input.today} from ${from}: \`data/\` as \`main\` had it then, with the ` +
      `assets built by the current tools, at \`schemaVersion\` ${SCHEMA_VERSION}.`,
    ...(facts.length > 0 ? ['', ...facts.map((f) => `- ${f}`)] : []),
  ].join('\n');
  return {
    tag: entry.tag,
    title: entry.title,
    notes: releaseNotes(
      (input.notesFile ?? entry.notes ?? texts.join('\n\n')).trim(),
      input.changelogUrl,
      extra,
    ),
    assets: releaseAssets(snapshot),
  };
}
