import { movedTo } from './moved.js';

/**
 * Turns two dataset snapshots (committed YAML vs. freshly scraped) into readable
 * change reports. One structured diff (`collectChanges`, plus `collectRules` for
 * `meta.yaml`) feeds three renderers here:
 *  - `changelog()` — the rich PR body (dated title, summary line, per-faction table,
 *    and the sections, folded away once they get long and shortened to fit GitHub's
 *    PR body limit);
 *  - `changelogEntry()` — the same entry in full, for the version's file under
 *    `changelog/` (`src/changelog.ts` assembles the files and their index);
 *  - `failuresReport()` — the per-faction parse errors for the workflow's issue (and
 *    `readFailuresReport()`, which reads one back for the drift fixer).
 * The first two share `sections()`, which lists each change a sub-faction shares with
 * its family once.
 * and a fourth next door: `announcement()` in `src/discord.ts` builds the webhook embed
 * from the same `collectChanges`/`tallies`/`totals` — exported for it, so the two
 * summaries cannot drift.
 * `updateWindow()`/`updateTitle()` date an update from the data itself, which is what
 * lets the sticky update PR keep its start date across force-pushes.
 * All pure except the loaders, which read a snapshot directory. The YAML git diff is the
 * canonical record — these are the human-readable views of it.
 *
 * This file is the public API; the modules behind it, under `src/diff/`:
 *  - `collect.ts` — the structured diff of the factions, with `units.ts` (which unit is
 *    which, and how its pricing is named) and `rules.ts` (`meta.yaml`);
 *  - `tally.ts` — the counts an update is summed up by;
 *  - `attention.ts` — the changes that look like a misread: the PR body's warning, the
 *    Discord summary's count and the `needs-attention` label;
 *  - `sections.ts` and `markdown.ts` — the Markdown renderers;
 *  - `naming.ts` — the version and the days an update is named by;
 *  - `failures.ts` and `load.ts` — the failure report, and reading snapshots from disk.
 */

export {
  attentionSection,
  collectAttention,
  type Flag,
  flagLine,
  needsAttention,
} from './diff/attention.js';
export { collectChanges, type FactionChanges, type Snapshot } from './diff/collect.js';
export { failuresReport, RULES_PANELS_FAILURE, readFailuresReport } from './diff/failures.js';
export { loadFactionDir, loadMeta, loadSnapshots, loadVersion } from './diff/load.js';
export { BODY_LIMIT, changelog, changelogEntry } from './diff/markdown.js';
export {
  changelogFile,
  type RenderOpts,
  updateTitle,
  updateVersion,
  updateWindow,
  windowLabel,
} from './diff/naming.js';

export { collectRules, type PanelChange, type RulesChanges } from './diff/rules.js';
export { sgn } from './diff/sections.js';
export { sharedHead, tallies, totals } from './diff/tally.js';
export { tierLabel } from './diff/units.js';

// This module used to be the `mfm diff` command: run directly, say where that went.
movedTo(import.meta.url, 'mfm diff');
