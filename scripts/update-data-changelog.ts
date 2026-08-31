import { readFileSync, writeFileSync } from 'node:fs';
import {
  changelogEntry,
  loadFactionDir,
  loadVersion,
  updateWindow,
  windowLabel,
} from '../src/diff.js';

/**
 * Prepend a dated Keep-a-Changelog entry to DATA-CHANGELOG.md for the changes
 * between two dataset snapshots. Run by the scrape workflow so each data-update PR
 * carries an accumulating, human-readable history:
 *
 *   tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]
 *
 * No-ops (leaving the file untouched) when there are no changes, so an unchanged
 * scrape produces no diff. `date` defaults to the update's own window — the days the
 * changed factions were first seen, which is stable across re-scrapes of the sticky
 * update PR and widens to `from → to` when a later day adds more. Pass it explicitly
 * to override.
 */

const FILE = 'DATA-CHANGELOG.md';
const MARKER = '<!-- BEGIN ENTRIES -->';

const [beforeDir, afterDir, dateArg] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]');
  process.exit(2);
}

const before = loadFactionDir(beforeDir);
const after = loadFactionDir(afterDir);
const version = loadVersion(afterDir);
const date = dateArg ?? windowLabel(updateWindow(before, after));
const entry = changelogEntry(before, after, version ? { date, version } : { date });
if (!entry) {
  console.log(`No data changes — ${FILE} left untouched.`);
  process.exit(0);
}

const current = readFileSync(FILE, 'utf8');
const at = current.indexOf(MARKER);
if (at === -1) throw new Error(`${FILE} is missing the "${MARKER}" insertion marker`);

const head = current.slice(0, at + MARKER.length);
const rest = current.slice(at + MARKER.length).replace(/^\s+/, '');
writeFileSync(FILE, `${head}\n\n${entry.trim()}\n\n${rest}`);
console.log(`Prepended a ${date} entry to ${FILE}.`);
