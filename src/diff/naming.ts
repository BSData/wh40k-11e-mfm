import { compareNames } from '../emit.js';
import type { SnapshotMeta } from '../model.js';
import { collectChanges, type Snapshot } from './collect.js';
import { collectRules } from './rules.js';

/**
 * Naming an update: the MFM version it lands on, and the days it spans, read from the
 * data itself, which is what lets the sticky update PR keep its start date across
 * force-pushes.
 */

export interface RenderOpts {
  /** Today, `YYYY-MM-DD` UTC. Defaults to the real clock; pass it for determinism. */
  today?: string;
  /** The MFM version this update lands on; defaults to `meta.after`'s. */
  version?: string;
  /**
   * Both snapshots' `meta.yaml` (`loadMeta()`), so the schema version, the site version
   * and the rules panels are diffed too. Without both, they aren't compared.
   */
  meta?: { before?: SnapshotMeta | undefined; after?: SnapshotMeta | undefined };
}

/**
 * The MFM version an update lands on: the site-wide one from `meta.yaml` when the
 * caller has it, otherwise the version most factions carry (they move together, but a
 * page can lag a revision behind — the majority is the update's version, not whichever
 * faction happens to sort first). Ties go to the higher version, so the answer does not
 * depend on directory order.
 */
export function updateVersion(after: Snapshot[], opts: RenderOpts = {}): string | undefined {
  const site = opts.version ?? opts.meta?.after?.version;
  if (site) return site;
  const tally = new Map<string, number>();
  for (const f of after) tally.set(f.version, (tally.get(f.version) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1] || compareNames(b[0], a[0]));
  return ranked[0]?.[0];
}

/**
 * The days a change set spans, read from the `firstSeen` stamps of the factions in it.
 * The scrape PR is sticky — a later run force-pushes onto the same branch — so an
 * update is not a single day's event. Taking the dates from the data instead of
 * stamping "now" on every run keeps the first day stable across re-scrapes that find
 * nothing new, and widens to a range only once a later scrape genuinely adds
 * something. Entries with no stamp (a removed faction, or bare parser content) count
 * as today, and so does a changed rules panel, alone or beside faction changes:
 * `meta.yaml` carries no stamp of its own, so each re-scrape re-dates it until it merges.
 * A change of the site version or `schemaVersion` alone doesn't count: a version bump
 * moves with the factions' own stamps, and counting it would re-date every version PR on
 * each daily re-scrape.
 */
export function updateWindow(
  before: Snapshot[],
  after: Snapshot[],
  opts: RenderOpts = {},
): { from: string; to: string } {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const dates = collectChanges(before, after).map((c) => c.firstSeen ?? today);
  if ((collectRules(opts.meta?.before, opts.meta?.after)?.panels.length ?? 0) > 0)
    dates.push(today);
  if (dates.length === 0) return { from: today, to: today };
  return {
    from: dates.reduce((a, b) => (b < a ? b : a)),
    to: dates.reduce((a, b) => (b > a ? b : a)),
  };
}

/** `2026-08-31`, or `2026-08-31 → 2026-09-02` once a sticky PR spans several days. */
export const windowLabel = (w: { from: string; to: string }): string =>
  w.from === w.to ? w.from : `${w.from} → ${w.to}`;

/**
 * What to call this update: `MFM v1.3 update — 2026-08-26`. Used verbatim as the PR
 * title, the changelog's `# ` heading and the commit subject, so the version and the
 * days it covers are legible from the merged history alone. Stable across re-scrapes,
 * widening as days accrue, except for an update with a rules panel change (see
 * `updateWindow`).
 */
export function updateTitle(before: Snapshot[], after: Snapshot[], opts: RenderOpts = {}): string {
  const version = updateVersion(after, opts);
  const what = version ? `MFM v${version} update` : 'MFM data update';
  return `${what} — ${windowLabel(updateWindow(before, after, opts))}`;
}

/** Where an MFM version's changelog file lives, relative to the repository root. */
export const changelogFile = (version: string | undefined): string =>
  `changelog/${version ? `v${version}` : 'unversioned'}.md`;
