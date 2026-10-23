import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { changelogIndex, withEntry } from '../../changelog.js';
import { INDEX } from '../../check-data.js';
import {
  changelogEntry,
  changelogFile,
  loadSnapshots,
  updateVersion,
  updateWindow,
  windowLabel,
} from '../../diff.js';
import { type Command, text } from '../command.js';

export const command: Command = {
  help: `usage: mfm changelog <beforeDir> <afterDir> [--date <date>] [--root <dir>]

Writes the changelog entry for the changes between two data/ snapshots into their MFM
version's file (changelog/v1.6.md), then regenerates the ${INDEX} index. Leaves both
untouched when nothing changed.

  --date <date>  the entry's date (default: the days the changed factions were first
                 seen, and today for a rules change, so a re-scrape of the update PR
                 keeps the first day)
  --root <dir>   the repository to write into (default: the current directory)
`,
  options: { date: { type: 'string' }, root: { type: 'string' } },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const root = text(values, 'root') ?? '.';
    const { before, after, meta } = loadSnapshots(beforeDir, afterDir);
    const date = text(values, 'date') ?? windowLabel(updateWindow(before, after, { meta }));
    const opts = { date, meta };
    const entry = changelogEntry(before, after, opts);
    if (!entry) {
      io.out(`No data changes — changelog and ${INDEX} left untouched.\n`);
      return 0;
    }
    const version = updateVersion(after, opts);
    const file = changelogFile(version);
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    writeFileSync(path, withEntry(current, version, entry));

    const dir = dirname(path);
    const files = readdirSync(dir).map((name) => ({
      name,
      text: readFileSync(join(dir, name), 'utf8'),
    }));
    writeFileSync(join(root, INDEX), changelogIndex(files));
    io.out(`Wrote a ${date} entry to ${file} and regenerated ${INDEX}.\n`);
    return 0;
  },
};
