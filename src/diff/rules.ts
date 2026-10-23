import type { SnapshotMeta } from '../model.js';

/** The `meta.yaml` diff: the schema version, the site-wide version and the rules panels. */

/** A rules panel that changed between two snapshots' `meta.yaml`. */
export interface PanelChange {
  label: string;
  status: 'added' | 'removed' | 'changed';
  /** The panel's line count: as it is now, or as it was when removed. */
  size: number;
  /** For a changed panel, its changed lines (see `lineDiff`); otherwise empty. */
  diff: string[];
}

/** What changed in `meta.yaml`: the schema version, the site-wide version and the rules panels. */
export interface RulesChanges {
  /**
   * `2 → 3` when `schemaVersion` moved (`— → 2` from a snapshot written before it
   * existed), `''` when it didn't. A bump is a breaking change to the files' shape.
   */
  schema: string;
  /** `v1.5 → v1.6` when the site version moved, `''` when it didn't. */
  version: string;
  panels: PanelChange[];
}

/** The rules panels, in the order the report lists them. */
const PANELS = [
  ['notes', 'Notes'],
  ['muster', 'Muster Armies'],
] as const;

/**
 * The lines only one side has, from a longest common subsequence: `- ` for a line only
 * in `a`, `+ ` for one only in `b`, and `…` between hunks that aren't adjacent. No
 * context lines: the reader has the panel itself in `meta.yaml`.
 */
function lineDiff(a: string[], b: string[]): string[] {
  const w = b.length + 1;
  // lcs[i * w + j]: the length of the longest common subsequence of a[i..] and b[j..].
  const lcs = new Array<number>((a.length + 1) * w).fill(0);
  const at = (i: number, j: number) => lcs[i * w + j] ?? 0;
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--)
      lcs[i * w + j] = a[i] === b[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));

  const out: string[] = [];
  const line = (sign: string, text = '') => (text ? `${sign} ${text}` : sign);
  let gap = false;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      gap = out.length > 0;
      i++;
      j++;
      continue;
    }
    if (gap) out.push('…');
    gap = false;
    if (i < a.length && (j === b.length || at(i + 1, j) >= at(i, j + 1)))
      out.push(line('-', a[i++]));
    else out.push(line('+', b[j++]));
  }
  return out;
}

/**
 * The `meta.yaml` diff, or `null` when there is nothing to report — including when
 * either snapshot has no meta to compare. `lastUpdated` and `factions` are derived from
 * the faction files, which are diffed in their own right.
 */
export function collectRules(
  before: SnapshotMeta | undefined,
  after: SnapshotMeta | undefined,
): RulesChanges | null {
  if (!before || !after) return null;
  const schema =
    before.schemaVersion === after.schemaVersion
      ? ''
      : `${before.schemaVersion ?? '—'} → ${after.schemaVersion ?? '—'}`;
  const version = before.version === after.version ? '' : `v${before.version} → v${after.version}`;
  const panels: PanelChange[] = [];
  for (const [field, label] of PANELS) {
    const was = before[field];
    const now = after[field];
    if (was === now) continue;
    if (!was) panels.push({ label, status: 'added', size: now?.split('\n').length ?? 0, diff: [] });
    else if (!now)
      panels.push({ label, status: 'removed', size: was.split('\n').length, diff: [] });
    else {
      const diff = lineDiff(was.split('\n'), now.split('\n'));
      panels.push({ label, status: 'changed', size: now.split('\n').length, diff });
    }
  }
  return schema || version || panels.length > 0 ? { schema, version, panels } : null;
}
