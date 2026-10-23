import { isDeepStrictEqual } from 'node:util';
import type { CostOption, PricingTier, Unit } from '../model.js';

/**
 * Which unit is which across two snapshots, and how a unit's pricing is named:
 * `matchUnits()` pairs the units up, `tierLabel()` words a requisition tier as the MFM
 * does, and `describeRetier()` sums up a unit whose pricing scheme changed.
 */

/** What a cost option is *for* — "3 models", a named option, an add-on. */
export const costLabel = (c: CostOption): string =>
  `${c.desc ?? `${c.models} model${c.models === 1 ? '' : 's'}`}${c.addon ? ' (add-on)' : ''}`;

const ordinal = (n: number): string => {
  const teen = n % 100 >= 11 && n % 100 <= 13;
  const suffix = teen ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] ?? 'th');
  return `${n}${suffix}`;
};

/**
 * A requisition tier as the MFM words it — `[1,2]` → `1st–2nd`, `[3,)` → `3rd+`,
 * `[1,1]` → `1st` — instead of the interval the data model stores. Anything that isn't
 * an interval is shown as-is.
 */
export function tierLabel(range: string): string {
  const m = range.match(/^\[(\d+),(\d*)[\])]$/);
  if (!m) return range;
  const from = Number(m[1]);
  if (!m[2]) return `${ordinal(from)}+`;
  const to = Number(m[2]);
  return from === to ? ordinal(from) : `${ordinal(from)}–${ordinal(to)}`;
}

/**
 * A unit as the diff sees it. A name is not unique within a faction: Imperial Agents
 * lists 29 twice (on the base roster and again under a sub-group), and Space Wolves has
 * two different "Venerable Dreadnought"s in one group. So `id` is the unit's group, its
 * name, and which of the units sharing both it is, in page order. `label` is what the
 * report calls it.
 */
export interface Listed {
  id: string;
  label: string;
  unit: Unit;
}

/** A unit's group and name: what its identity shares with any namesake in that group. */
const groupedName = (u: Unit): string => JSON.stringify([u.groupTitle ?? '', u.name]);

/** Whether two units are alike in everything but the sub-group they sit under. */
const sameContent = (a: Unit, b: Unit): boolean =>
  isDeepStrictEqual({ ...a, groupTitle: undefined }, { ...b, groupTitle: undefined });

/** Names that more than one unit carries in either snapshot, by `pick`. */
function repeated(snapshots: Unit[][], pick: (u: Unit) => string): Set<string> {
  const out = new Set<string>();
  for (const units of snapshots) {
    const seen = new Set<string>();
    for (const u of units) {
      if (seen.has(pick(u))) out.add(pick(u));
      seen.add(pick(u));
    }
  }
  return out;
}

/**
 * Both snapshots' units, identified, labelled and matched up, in four passes over the new
 * units in page order, each taking the first old unit still unpaired: the same group and
 * name with identical content, the same group and name, the same name with identical
 * content, the same name. So a unit that moved into a group that already has its namesake
 * reads as changed, not as two reprices, and one that changed sub-group reads as changed
 * rather than as one unit removed and another added.
 *
 * A label is the bare name unless another unit in either snapshot carries it; then it
 * adds the group, `Inquisitor (Every Model Has the Imperium Keyword)`, and, if that
 * still doesn't tell them apart, the position: `Venerable Dreadnought (#2)`.
 */
export function matchUnits(before: Unit[], after: Unit[]) {
  const sameName = repeated([before, after], (u) => u.name);
  const sameGroup = repeated([before, after], groupedName);
  const listed = (units: Unit[]): Listed[] => {
    const seen = new Map<string, number>();
    return units.map((unit) => {
      const index = seen.get(groupedName(unit)) ?? 0;
      seen.set(groupedName(unit), index + 1);
      const tags = [
        sameName.has(unit.name) ? unit.groupTitle : undefined,
        sameGroup.has(groupedName(unit)) ? `#${index + 1}` : undefined,
      ].filter((t): t is string => t !== undefined);
      const label = tags.length > 0 ? `${unit.name} (${tags.join(', ')})` : unit.name;
      return { id: `${groupedName(unit)}#${index}`, label, unit };
    });
  };
  const now = listed(after);
  const left = listed(before);
  const partner = new Map<Listed, Listed>();
  const pass = (fits: (now: Listed, was: Listed) => boolean) => {
    for (const l of now) {
      if (partner.has(l)) continue;
      const i = left.findIndex((was) => fits(l, was));
      if (i === -1) continue;
      partner.set(l, left[i] as Listed);
      left.splice(i, 1);
    }
  };
  pass((l, was) => groupedName(l.unit) === groupedName(was.unit) && sameContent(l.unit, was.unit));
  pass((l, was) => groupedName(l.unit) === groupedName(was.unit));
  pass((l, was) => l.unit.name === was.unit.name && sameContent(l.unit, was.unit));
  pass((l, was) => l.unit.name === was.unit.name);
  // The old side takes its partner's id, so the two key their rows alike.
  const pairs = now.flatMap((l) => {
    const was = partner.get(l);
    return was ? [{ was: { ...was, id: l.id }, now: l }] : [];
  });
  return { pairs, added: now.filter((l) => !partner.has(l)), removed: left };
}

/**
 * A unit whose pricing **scheme** changed: GW added or dropped a requisition tier, so
 * the same unit is now costed differently rather than gaining or losing anything.
 *
 * This has to be its own category. Cost rows are keyed by `unit · tier · option`, so a
 * unit going from one tier to two rewrites every key it has — reported row by row, one
 * such unit becomes a wall of removals and additions. In MFM v1.3 eight units picked up
 * a `3rd+` threshold and produced 45 of the changelog's 70 add/remove lines, none of
 * which was an addition or a removal in any sense a reader cares about. Collapsed here
 * to one line per unit that says what actually happened, and filed under *changed*.
 */
export interface Retier {
  /** The unit's identity (see `Listed`), so the tallies count it once. */
  unit: string;
  text: string;
}

/** Every option's points across a unit's tiers, in tier order, keyed by option label. */
export function pricesByOption(pricing: PricingTier[]): Map<string, number[]> {
  const m = new Map<string, number[]>();
  for (const t of pricing) {
    for (const c of t.costs) {
      const key = costLabel(c);
      m.set(key, [...(m.get(key) ?? []), c.points]);
    }
  }
  return m;
}

/** The tier ranges a unit is priced over — its pricing scheme's identity. */
export const tierRanges = (u: Unit): string[] => u.pricing.map((t) => t.range);

/**
 * One line describing a re-tiering: the tiers before and after, then each option's old
 * price and its new price in every tier — `1st+ → 1st–2nd / 3rd+; 5 models: 275 → 280 /
 * 310`. Tiers and prices are both `/`-separated, so each price sits under its tier.
 */
export function describeRetier(before: Unit, { id, label, unit: after }: Listed): Retier {
  const old = pricesByOption(before.pricing);
  const now = pricesByOption(after.pricing);
  const rows: string[] = [];
  for (const [label, points] of now) {
    const was = old.get(label);
    rows.push(`${label}: ${was ? was.join(' / ') : '—'} → ${points.join(' / ')}`);
  }
  for (const [label, points] of old) {
    if (!now.has(label)) rows.push(`${label}: ${points.join(' / ')} → —`);
  }
  const scheme = (u: Unit) => tierRanges(u).map(tierLabel).join(' / ');
  const tiers = `${scheme(before)} → ${scheme(after)}`;
  return { unit: id, text: `${label} — re-tiered ${tiers}; ${rows.join(' · ')}` };
}
