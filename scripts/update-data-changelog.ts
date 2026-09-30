import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changelogIndex, withEntry } from '../src/changelog.js';
import {
  changelogEntry,
  changelogFile,
  loadFactionDir,
  loadVersion,
  updateVersion,
  updateWindow,
  windowLabel,
} from '../src/diff.js';

/**
 * Write the changelog entry for the changes between two dataset snapshots into their MFM
 * version's file (`changelog/v1.5.md`), then regenerate the DATA-CHANGELOG.md index. Run
 * by the scrape workflow so each data-update PR carries its durable, readable history:
 *
 *   tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]
 *
 * No-ops (leaving both untouched) when there are no changes, so an unchanged scrape
 * produces no diff. `date` defaults to the update's own window — the days the changed
 * factions were first seen, which is stable across re-scrapes of the sticky update PR
 * and widens to `from → to` when a later day adds more. Pass it explicitly to override.
 */

const INDEX = 'DATA-CHANGELOG.md';

const [beforeDir, afterDir, dateArg] = process.argv.slice(2);
if (!beforeDir || !afterDir) {
  console.error('usage: tsx scripts/update-data-changelog.ts <beforeDir> <afterDir> [date]');
  process.exit(2);
}

const before = loadFactionDir(beforeDir);
const after = loadFactionDir(afterDir);
const siteVersion = loadVersion(afterDir);
const date = dateArg ?? windowLabel(updateWindow(before, after));
const opts = siteVersion ? { date, version: siteVersion } : { date };
const entry = changelogEntry(before, after, opts);
if (!entry) {
  console.log(`No data changes — changelog and ${INDEX} left untouched.`);
  process.exit(0);
}

const version = updateVersion(after, opts);
const file = changelogFile(version);
const dir = dirname(file);
mkdirSync(dir, { recursive: true });
writeFileSync(
  file,
  withEntry(existsSync(file) ? readFileSync(file, 'utf8') : undefined, version, entry),
);

const files = readdirSync(dir).map((name) => ({
  name,
  text: readFileSync(join(dir, name), 'utf8'),
}));
writeFileSync(INDEX, changelogIndex(files));
console.log(`Wrote a ${date} entry to ${file} and regenerated ${INDEX}.`);
