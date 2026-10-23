import type { Attr, Delta, FactionChanges, NumericDiff } from './collect.js';
import type { PanelChange, RulesChanges } from './rules.js';

/** The numbers an update is summed up by, per faction and in total. */

const countDeltas = (deltas: Delta[]) => {
  let up = 0;
  let down = 0;
  let net = 0;
  for (const d of deltas) {
    const diff = d.to - d.from;
    net += diff;
    if (diff > 0) up++;
    else if (diff < 0) down++;
  }
  return { up, down, net, changed: deltas.length };
};

const allDeltas = (c: FactionChanges) => [...c.costs.deltas, ...c.wargear.deltas, ...c.enh.deltas];

/** How many distinct entities a set of numeric diffs and attribute notes touches. */
const touched = (diffs: NumericDiff[], notes: Attr[], also: string[] = []): number => {
  const names = new Set<string>(also);
  for (const d of diffs)
    for (const row of [...d.deltas, ...d.added, ...d.removed]) names.add(row.entity);
  for (const n of notes) names.add(n.entity);
  return names.size;
};

/**
 * Per-faction tallies used by the summary line and table. `uC`/`dC` count entities
 * changed **in place** — repriced, re-tiered or edited — which is what a routine MFM
 * update consists of. Without them the Units and Detachments columns only ever see
 * whole entities appearing or disappearing, so they read "—" on every row, and a
 * faction whose changes are all re-tiered cost rows or attribute edits gets an
 * all-"—" row above a section full of changes. Every non-empty section must show up
 * in its row.
 */
export function tallies(c: FactionChanges) {
  const still = { up: 0, down: 0, net: 0, changed: 0 };
  if (c.status === 'added')
    return { uA: c.unitCount, uR: 0, uC: 0, dA: c.detCount, dR: 0, dC: 0, ...still };
  if (c.status === 'removed')
    return { uA: 0, uR: c.unitCount, uC: 0, dA: 0, dR: c.detCount, dC: 0, ...still };
  return {
    uA: c.unitsAdded.length,
    uR: c.unitsRemoved.length,
    uC: touched(
      [c.costs, c.wargear],
      c.unitOther,
      c.retiered.map((r) => r.unit),
    ),
    dA: c.detsAdded.length,
    dR: c.detsRemoved.length,
    dC: touched([c.enh], c.detOther),
    ...countDeltas(allDeltas(c)),
  };
}

/**
 * Every faction's tallies summed — the numbers a whole-update summary is built from —
 * plus the rules panels added, removed and changed (`rA`/`rR`/`rC`). Shared by the
 * changelog's summary line and the Discord embed so the two can't report different
 * totals for the same update.
 */
export function totals(changes: FactionChanges[], rules: RulesChanges | null = null) {
  const t = changes.map(tallies);
  const sum = (pick: (x: (typeof t)[number]) => number) => t.reduce((s, x) => s + pick(x), 0);
  const panels = (status: PanelChange['status']) =>
    rules?.panels.filter((p) => p.status === status).length ?? 0;
  return {
    rA: panels('added'),
    rR: panels('removed'),
    rC: panels('changed'),
    factions: changes.length,
    news: changes.filter((c) => c.status === 'added').length,
    gone: changes.filter((c) => c.status === 'removed').length,
    uA: sum((x) => x.uA),
    uR: sum((x) => x.uR),
    uC: sum((x) => x.uC),
    dA: sum((x) => x.dA),
    dR: sum((x) => x.dR),
    dC: sum((x) => x.dC),
    up: sum((x) => x.up),
    down: sum((x) => x.down),
    net: sum((x) => x.net),
    changed: sum((x) => x.changed),
    retiered: changes.reduce((n, c) => n + c.retiered.length, 0),
  };
}

/**
 * The version/parent note every changed faction carries, when they all carry the same
 * one — `v1.2 → v1.3`. An MFM revision bumps every faction at once, so a universal note
 * is a fact about the update rather than about any one faction, and is stated once
 * instead of on every row. `''` when the notes differ, are absent, or only one faction
 * changed (nothing for it to be universal across).
 */
export function sharedHead(changes: FactionChanges[]): string {
  const heads = changes.map((c) => c.head.join(', '));
  const first = heads[0] ?? '';
  return heads.length > 1 && heads.every((h) => h !== '' && h === first) ? first : '';
}
