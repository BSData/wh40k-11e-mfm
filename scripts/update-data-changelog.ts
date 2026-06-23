import { readFileSync, writeFileSync } from 'node:fs';
import { changelogEntry, loadFactionDir } from '../src/diff.js';

/**
 * Prepend a dated Keep-a-Changelog entry to DATA-CHANGELOG.md for the changes
 * between two dataset snapshots. Run by the scrape workflow so each data-update PR
 * carries an accumulating, human-readable history:
 *
 *   tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]
 *
 * No-ops (leaving the file untouched) when there are no changes, so an unchanged
 * scrape produces no diff. `date` defaults to today (UTC); pass it for determinism.
 */

const FILE = 'DATA-CHANGELOG.md';
const MARKER = '<!-- BEGIN ENTRIES -->';

const [beforeDir, afterDir, dateArg] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]');
  process.exit(2);
}

const date = dateArg ?? new Date().toISOString().slice(0, 10);
const entry = changelogEntry(loadFactionDir(beforeDir), loadFactionDir(afterDir), { date });
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
