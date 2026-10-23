import { compareNames } from '../emit.js';
import type { FactionContent } from '../model.js';
import {
  costLabel,
  describeRetier,
  type Listed,
  matchUnits,
  type Retier,
  tierLabel,
  tierRanges,
} from './units.js';

/**
 * The structured diff of two dataset snapshots, one `FactionChanges` per faction that
 * changed: what every renderer is built from.
 */

/**
 * A snapshot entry: parsed faction content plus the `firstSeen` stamp it carries when
 * loaded from disk (bare parser output has none).
 */
export type Snapshot = FactionContent & { firstSeen?: string };

const unitNames = (f: FactionContent) => new Set(f.units.map((u) => u.name));
const detNames = (f: FactionContent) => new Set(f.detachments.map((d) => d.name));
const onlyIn = (a: Set<string>, b: Set<string>) =>
  [...a].filter((x) => !b.has(x)).sort(compareNames);

/** Changed list members, or full lists when order or repeated entries need preserving. */
function listDelta(before: string[] | undefined, after: string[] | undefined): string {
  const previous = before ?? [];
  const current = after ?? [];
  if (previous.length === current.length && previous.every((name, i) => name === current[i]))
    return '';

  const old = new Set(previous);
  const now = new Set(current);
  const retainedBefore = previous.filter((name) => now.has(name));
  const retainedAfter = current.filter((name) => old.has(name));
  const reordered =
    retainedBefore.length !== retainedAfter.length ||
    retainedBefore.some((name, i) => name !== retainedAfter[i]);
  const removed = onlyIn(old, now);
  const added = onlyIn(now, old);
  if (
    reordered ||
    previous.length !== old.size ||
    current.length !== now.size ||
    (removed.length === 0 && added.length === 0)
  )
    return `  - **Before:** ${previous.join(', ') || '—'}\n  - **After:** ${current.join(', ') || '—'}`;

  const changes = [
    ...removed.map((name) => `  - ➖ ${name}`),
    ...added.map((name) => `  - ➕ ${name}`),
  ];
  return changes.join('\n');
}

/** A keyed numeric value (a unit cost option, a wargear item, or an enhancement). */
export interface Numeric {
  display: string;
  points: number;
  entity: string; // owning unit or detachment, so we can skip lines of added/removed entities
}

/** Unit cost options keyed by `unit · tier · option`. */
function costRows(units: Listed[]): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const { id, label, unit: u } of units) {
    for (const t of u.pricing) {
      const tier = u.pricing.length > 1 ? ` (${tierLabel(t.range)})` : '';
      for (const c of t.costs) {
        const what = costLabel(c);
        m.set(`${id}\n${t.range}\n${what}`, {
          entity: id,
          points: c.points,
          display: `${label} — ${what}${tier}`,
        });
      }
    }
  }
  return m;
}

/** Wargear items keyed by `unit · item`. */
function wargearRows(units: Listed[]): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const { id, label, unit: u } of units) {
    for (const w of u.wargear ?? []) {
      m.set(`${id}\n${w.item}`, {
        entity: id,
        points: w.points,
        display: `${label} — ${w.item}`,
      });
    }
  }
  return m;
}

/** Enhancements keyed by `detachment · enhancement`. */
function enhRows(f: FactionContent): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const d of f.detachments) {
    for (const e of d.enhancements) {
      m.set(`${d.name} ${e.name}`, {
        entity: d.name,
        points: e.points,
        display: `${d.name} · ${e.name}`,
      });
    }
  }
  return m;
}

export interface Delta {
  display: string;
  from: number;
  to: number;
  /** Owning unit/detachment, so the summary table can count entities touched. */
  entity: string;
}
export interface NumericDiff {
  deltas: Delta[];
  added: Numeric[];
  removed: Numeric[];
}

/** Diff two keyed-numeric maps, ignoring rows whose owning entity isn't in both snapshots. */
function diffNumeric(
  before: Map<string, Numeric>,
  after: Map<string, Numeric>,
  inBoth: (entity: string) => boolean,
): NumericDiff {
  const deltas: Delta[] = [];
  const addedRows: Numeric[] = [];
  const removedRows: Numeric[] = [];
  for (const [key, row] of after) {
    if (!inBoth(row.entity)) continue;
    const prev = before.get(key);
    if (!prev) addedRows.push(row);
    else if (prev.points !== row.points)
      deltas.push({
        display: row.display,
        entity: row.entity,
        from: prev.points,
        to: row.points,
      });
  }
  for (const [key, row] of before) {
    if (!inBoth(row.entity) || after.has(key)) continue;
    removedRows.push(row);
  }
  deltas.sort(
    (a, b) =>
      Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || compareNames(a.display, b.display),
  );
  const byName = (a: Numeric, b: Numeric) => compareNames(a.display, b.display);
  return { deltas, added: addedRows.sort(byName), removed: removedRows.sort(byName) };
}

/** A non-numeric attribute change, keyed by the entity it belongs to. */
export interface Attr {
  entity: string;
  text: string;
}

/** The structured diff of one faction, shared by all renderers. */
export interface FactionChanges {
  slug: string;
  name: string;
  /** The scraped snapshot's `firstSeen` — the day this content appeared. */
  firstSeen?: string;
  /** The parent army a sub-faction's page names — the family its changes are shared in. */
  parent?: string;
  status: 'added' | 'removed' | 'changed';
  unitCount: number; // for whole-faction added/removed
  detCount: number;
  head: string[]; // version / parent notes
  unitsAdded: string[];
  unitsRemoved: string[];
  detsAdded: string[];
  detsRemoved: string[];
  costs: NumericDiff;
  wargear: NumericDiff;
  enh: NumericDiff;
  retiered: Retier[];
  unitOther: Attr[];
  detOther: Attr[];
}

const emptyDiff = (): NumericDiff => ({ deltas: [], added: [], removed: [] });

/** Diff a faction present in both snapshots; `null` if nothing changed. */
function computeChanges(before: FactionContent, after: FactionContent): FactionChanges | null {
  const head: string[] = [];
  if (before.version !== after.version) head.push(`v${before.version} → v${after.version}`);
  if (before.parent !== after.parent)
    head.push(`parent ${before.parent ?? '—'} → ${after.parent ?? '—'}`);
  if (before.name !== after.name) head.push(`renamed from ${before.name}`);

  // Units are compared by identity, not by name — see `matchUnits`.
  const { pairs, added, removed } = matchUnits(before.units, after.units);
  const od = detNames(before);
  const nd = detNames(after);
  const bothDet = (n: string) => od.has(n) && nd.has(n);

  // Units whose tier structure changed are described whole, and kept out of the cost
  // diff — every one of their keys moved, so row-by-row it is all noise.
  const retiered: Retier[] = [];
  for (const { was, now } of pairs) {
    if (tierRanges(was.unit).join('|') !== tierRanges(now.unit).join('|'))
      retiered.push(describeRetier(was.unit, now));
  }
  const wasRetiered = new Set(retiered.map((r) => r.unit));

  const olds = pairs.map((p) => p.was);
  const nows = pairs.map((p) => p.now);
  const costs = diffNumeric(costRows(olds), costRows(nows), (id) => !wasRetiered.has(id));
  const wargear = diffNumeric(wargearRows(olds), wargearRows(nows), () => true);
  const enh = diffNumeric(enhRows(before), enhRows(after), bothDet);

  // A Leader/Support target the faction lost is dropped from the old list before
  // comparing: nothing can lead a unit that isn't there, and "Units removed" already says
  // so. Kept, it is that one fact again under every leader that used to take it. The
  // lists hold bare names, so a name is lost only when no unit carries it any more.
  const gone = new Set(onlyIn(unitNames(before), unitNames(after)));
  const grantDelta = (was: string[] | undefined, now: string[] | undefined) =>
    listDelta(
      was?.filter((name) => !gone.has(name)),
      now,
    );

  // Non-numeric attribute changes on entities present in both snapshots.
  const unitOther: Attr[] = [];
  for (const { was, now } of pairs) {
    const [p, u] = [was.unit, now.unit];
    const note = (text: string) =>
      unitOther.push({ entity: now.id, text: `${now.label} — ${text}` });
    if (p.legends !== u.legends) note(u.legends ? 'moved to Legends' : 'moved out of Legends');
    if (p.groupTitle !== u.groupTitle)
      note(`group: ${p.groupTitle ?? '—'} → ${u.groupTitle ?? '—'}`);
    for (const grant of ['leaderTo', 'supportTo'] as const) {
      const delta = grantDelta(p[grant], u[grant]);
      if (delta) note(`${grant}:\n${delta}`);
    }
    // A tier's heading, where the tier itself is kept; a new or dropped tier is a re-tier.
    const labels = new Map(p.pricing.map((t) => [t.range, t.label]));
    for (const t of u.pricing) {
      const label = labels.get(t.range);
      if (label !== undefined && label !== t.label)
        note(`label (${tierLabel(t.range)}): ${label} → ${t.label}`);
    }
  }
  const detOther: Attr[] = [];
  const beforeDets = new Map(before.detachments.map((d) => [d.name, d]));
  for (const d of after.detachments) {
    const p = beforeDets.get(d.name);
    if (!p) continue;
    const note = (text: string) => detOther.push({ entity: d.name, text });
    if (p.dp !== d.dp) note(`${d.name} — DP: ${p.dp ?? '—'} → ${d.dp ?? '—'}`);
    const objectives = listDelta(p.objectives, d.objectives);
    if (objectives) note(`${d.name} — objectives:\n${objectives}`);
    if ((p.unique ?? '') !== (d.unique ?? ''))
      note(`${d.name} — unique: ${p.unique ?? '—'} → ${d.unique ?? '—'}`);
    const pe = new Map(p.enhancements.map((e) => [e.name, e]));
    for (const e of d.enhancements) {
      const x = pe.get(e.name);
      if (!x) continue;
      for (const grant of ['leaderTo', 'supportTo'] as const) {
        const delta = grantDelta(x[grant], e[grant]);
        if (delta) note(`${d.name} · ${e.name} — ${grant}:\n${delta}`);
      }
    }
  }

  const changes: FactionChanges = {
    slug: after.slug,
    name: after.name,
    status: 'changed',
    unitCount: after.units.length,
    detCount: after.detachments.length,
    head,
    unitsAdded: added.map((l) => l.label).sort(compareNames),
    unitsRemoved: removed.map((l) => l.label).sort(compareNames),
    detsAdded: onlyIn(nd, od),
    detsRemoved: onlyIn(od, nd),
    costs,
    wargear,
    enh,
    retiered,
    unitOther,
    detOther,
  };

  const empty =
    head.length === 0 &&
    changes.unitsAdded.length === 0 &&
    changes.unitsRemoved.length === 0 &&
    changes.detsAdded.length === 0 &&
    changes.detsRemoved.length === 0 &&
    unitOther.length === 0 &&
    detOther.length === 0 &&
    retiered.length === 0 &&
    [costs, wargear, enh].every(
      (d) => d.deltas.length === 0 && d.added.length === 0 && d.removed.length === 0,
    );
  return empty ? null : changes;
}

/** A faction that appeared or disappeared entirely. */
function wholeFaction(f: FactionContent, status: 'added' | 'removed'): FactionChanges {
  return {
    slug: f.slug,
    name: f.name,
    status,
    unitCount: f.units.length,
    detCount: f.detachments.length,
    head: [],
    unitsAdded: [],
    unitsRemoved: [],
    detsAdded: [],
    detsRemoved: [],
    costs: emptyDiff(),
    wargear: emptyDiff(),
    enh: emptyDiff(),
    retiered: [],
    unitOther: [],
    detOther: [],
  };
}

/** All faction changes between two snapshots: changed/added (by name), then removed. */
export function collectChanges(before: Snapshot[], after: Snapshot[]): FactionChanges[] {
  const beforeBySlug = new Map(before.map((f) => [f.slug, f]));
  const afterBySlug = new Map(after.map((f) => [f.slug, f]));
  const out: FactionChanges[] = [];
  // Carried only when present: bare parser content (tests, one-off diffs) has no stamp,
  // and only sub-factions have a parent.
  const seen = (f: Snapshot) => (f.firstSeen ? { firstSeen: f.firstSeen } : {});
  const family = (f: Snapshot) => (f.parent ? { parent: f.parent } : {});
  for (const f of [...after].sort((a, b) => compareNames(a.name, b.name))) {
    const prev = beforeBySlug.get(f.slug);
    if (!prev) out.push({ ...wholeFaction(f, 'added'), ...seen(f), ...family(f) });
    else {
      const c = computeChanges(prev, f);
      if (c) out.push({ ...c, ...seen(f), ...family(f) });
    }
  }
  for (const f of [...before].sort((a, b) => compareNames(a.name, b.name))) {
    if (!afterBySlug.has(f.slug)) out.push({ ...wholeFaction(f, 'removed'), ...family(f) });
  }
  return out;
}
