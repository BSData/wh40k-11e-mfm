import { compareNames } from '../emit.js';
import type { CostOption, PricingTier } from '../model.js';
import {
  collectChanges,
  costDisplay,
  type Delta,
  type FactionChanges,
  type Snapshot,
} from './collect.js';
import type { RenderOpts } from './naming.js';
import { collectRules, type RulesChanges } from './rules.js';
import { listing, plural } from './sections.js';
import { sharedHead } from './tally.js';
import { costLabel, matchUnits, pricesByOption, tierRanges } from './units.js';

/**
 * The changes more likely the scraper misreading the site than GW changing it: what the
 * PR body lists under "Needs attention", what the Discord summary counts, and what the
 * update PR is labelled `needs-attention` for. See "Needs attention" in
 * specs/change-tracking.md, and docs/decisions/0027 for where the thresholds come from,
 * 0037 for the cost rows that are new to their unit.
 */

/** A value this many times bigger, or smaller, than before is flagged. */
export const FACTOR = 3;

/** The most flags the PR body lists; the rest are counted, and `mfm attention` lists all. */
export const MAX_LISTED = 50;

export type FlagKind = 'gone' | 'units-lost' | 'version-only' | 'to-zero' | 'threefold';

/** One line of the warning: what moved, and every faction it moved in. */
export interface Flag {
  kind: FlagKind;
  /** The factions it is about, by name; none for the update as a whole. */
  factions: string[];
  /** What moved, after the factions' names. */
  what: string;
}

/** The order the lines are listed in: whole factions first, then single values. */
const ORDER: FlagKind[] = ['gone', 'units-lost', 'version-only', 'to-zero', 'threefold'];

/** A factor to one decimal place: "3.5", "4". */
const times = (x: number): string => String(Math.round(x * 10) / 10);

/**
 * Why a value going from `from` to `to` needs attention: it dropped to 0, or changed
 * threefold or more, either way (up from 0 counts). `undefined` when it doesn't.
 */
export function valueNote(
  from: number,
  to: number,
): { kind: 'to-zero' | 'threefold'; note: string } | undefined {
  if (from === to) return undefined;
  if (to === 0) return { kind: 'to-zero', note: 'to 0' };
  if (from === 0) return { kind: 'threefold', note: 'up from 0' };
  if (to >= FACTOR * from) return { kind: 'threefold', note: `×${times(to / from)}` };
  if (from >= FACTOR * to) return { kind: 'threefold', note: `÷${times(from / to)}` };
  return undefined;
}

/**
 * A re-tiered option's new prices against the range of its old ones: a new price above
 * the old highest is measured from it, one below the old lowest from that. The first
 * price that needs attention, in tier order, says why.
 */
function retierNote(olds: number[], news: number[]) {
  const lo = Math.min(...olds);
  const hi = Math.max(...olds);
  for (const n of news) {
    const note = n > hi ? valueNote(hi, n) : n < lo ? valueNote(lo, n) : undefined;
    if (note) return note;
  }
  return undefined;
}

/**
 * Why a cost option its unit didn't have needs attention: it costs 0, or its price per
 * model (`points / models`) is threefold the highest of `old`'s, or a third of the lowest or
 * less, `old` being the unit's old options in every tier. An add-on prices an extra, and a
 * row of no models has no price per model: neither is measured, nor is any row against old
 * options that have none. `undefined` when it doesn't.
 */
function newRowNote(
  old: CostOption[],
  cost: CostOption,
): { kind: 'to-zero' | 'threefold'; note: string } | undefined {
  if (cost.points === 0) return { kind: 'to-zero', note: 'at 0' };
  const priced = (c: CostOption) => !c.addon && c.models > 0;
  if (!priced(cost)) return undefined;
  const rates = old.filter(priced).map((c) => c.points / c.models);
  if (rates.length === 0) return undefined;
  const lo = Math.min(...rates);
  const hi = Math.max(...rates);
  const p = cost.points / cost.models;
  const note = p > hi ? valueNote(hi, p) : p < lo ? valueNote(lo, p) : undefined;
  return note && { kind: 'threefold', note: `${note.note} per model` };
}

/** A cost row's key within its unit, as the cost diff keys it. */
const rowKey = (t: PricingTier, c: CostOption): string => `${t.range}\n${costLabel(c)}`;

const VERSION_NOTE = /^v\S+ → v\S+$/;

/** A faction whose only change is its version number. */
const versionOnly = (c: FactionChanges): boolean =>
  c.status === 'changed' &&
  c.head.length > 0 &&
  c.head.every((h) => VERSION_NOTE.test(h)) &&
  [
    c.unitsAdded,
    c.unitsRemoved,
    c.detsAdded,
    c.detsRemoved,
    c.retiered,
    c.unitOther,
    c.detOther,
  ].every((list) => list.length === 0) &&
  [c.costs, c.wargear, c.enh].every(
    (d) => d.deltas.length === 0 && d.added.length === 0 && d.removed.length === 0,
  );

/** What a gone faction had: "64 units and 12 detachments". */
const contents = (units: number, dets: number): string =>
  listing(
    [units > 0 ? plural(units, 'unit') : '', dets > 0 ? plural(dets, 'detachment') : ''].filter(
      Boolean,
    ),
  ) || 'nothing in it';

/**
 * Every flag in an update, in listing order, a value's flag merged where several factions
 * share it word for word (a sub-faction carries its parent's roster). `changes` and
 * `rules` are the update's diff. The snapshots are read again for the re-tiered units,
 * whose prices the diff keeps out of its cost rows, and for the cost rows new to their
 * unit, which have no old value to compare; `meta` for the site's index.
 */
export function collectAttention(
  changes: FactionChanges[],
  rules: RulesChanges | null,
  before: Snapshot[],
  after: Snapshot[],
  meta: RenderOpts['meta'] = {},
): Flag[] {
  const flags: Flag[] = [];
  /** A value's flag, merged into the same line from another faction when there is one. */
  const add = (kind: FlagKind, faction: string, what: string) => {
    const same = flags.find((f) => f.kind === kind && f.what === what);
    if (same) same.factions.push(faction);
    else flags.push({ kind, factions: [faction], what });
  };

  const beforeBySlug = new Map(before.map((f) => [f.slug, f]));
  const afterBySlug = new Map(after.map((f) => [f.slug, f]));
  for (const c of changes) {
    if (c.status === 'removed') {
      const what = `is gone from the site (it had ${contents(c.unitCount, c.detCount)})`;
      flags.push({ kind: 'gone', factions: [c.name], what });
      continue;
    }
    if (c.status !== 'changed') continue;

    // `unitCount` is the new snapshot's: the old one had the units kept plus those gone.
    const had = c.unitCount - c.unitsAdded.length + c.unitsRemoved.length;
    if (2 * c.unitsRemoved.length > had) {
      const gained = c.unitsAdded.length > 0 ? ` (and gained ${c.unitsAdded.length})` : '';
      const what = `lost ${c.unitsRemoved.length} of its ${plural(had, 'unit')}${gained}`;
      flags.push({ kind: 'units-lost', factions: [c.name], what });
    }

    const value = (d: Delta) => {
      const v = valueNote(d.from, d.to);
      if (v) add(v.kind, c.name, `${d.display}: ${d.from} → ${d.to} (${v.note})`);
    };
    for (const d of [...c.costs.deltas, ...c.wargear.deltas, ...c.enh.deltas]) value(d);

    if (c.costs.added.length === 0 && c.retiered.length === 0) continue;
    const was = beforeBySlug.get(c.slug);
    const now = afterBySlug.get(c.slug);
    if (!was || !now) continue;
    for (const pair of matchUnits(was.units, now.units).pairs) {
      const [oldUnit, newUnit] = [pair.was.unit, pair.now.unit];
      const oldCosts = oldUnit.pricing.flatMap((t) => t.costs);
      if (tierRanges(oldUnit).join('|') === tierRanges(newUnit).join('|')) {
        // Not re-tiered: a row whose key the old unit doesn't have is new to it.
        const had = new Set(oldUnit.pricing.flatMap((t) => t.costs.map((x) => rowKey(t, x))));
        for (const t of newUnit.pricing) {
          for (const cost of t.costs) {
            if (had.has(rowKey(t, cost))) continue;
            const note = newRowNote(oldCosts, cost);
            if (!note) continue;
            const detail = note.kind === 'to-zero' ? '' : ` (${note.note})`;
            const what = `${costDisplay(pair.now, t, cost)}: new at ${cost.points}${detail}`;
            add(note.kind, c.name, what);
          }
        }
        continue;
      }
      const olds = pricesByOption(oldUnit.pricing);
      for (const [option, news] of pricesByOption(newUnit.pricing)) {
        const old = olds.get(option);
        if (old) {
          const note = retierNote(old, news);
          if (note) {
            const prices = `${old.join(' / ')} → ${news.join(' / ')}`;
            const what = `${pair.now.label} — ${option}: ${prices} (re-tiered, ${note.note})`;
            add(note.kind, c.name, what);
          }
          continue;
        }
        // An option the unit didn't have before: its costs in tier order, the first that
        // needs attention says why.
        for (const cost of newUnit.pricing.flatMap((t) => t.costs)) {
          if (costLabel(cost) !== option) continue;
          const note = newRowNote(oldCosts, cost);
          if (!note) continue;
          const what = `${pair.now.label} — ${option}: — → ${news.join(' / ')} (re-tiered, new option, ${note.note})`;
          add(note.kind, c.name, what);
          break;
        }
      }
    }
  }

  // A faction the site's index stopped listing. The scraper writes only what the index
  // lists and deletes nothing, so its old file stays in `data/` unchanged and the diff
  // never sees it go: `meta.yaml`'s list of factions is where it shows.
  const reported = new Set(changes.filter((c) => c.status === 'removed').map((c) => c.slug));
  const listed = new Set(meta?.after?.factions ?? []);
  if (meta?.after) {
    for (const slug of meta.before?.factions ?? []) {
      if (listed.has(slug) || reported.has(slug)) continue;
      const f = beforeBySlug.get(slug);
      if (!f) {
        const what =
          "is gone from the site's index (`meta.yaml` listed it, but it had no `data/` file)";
        flags.push({ kind: 'gone', factions: [`\`${slug}\``], what });
        continue;
      }
      const had = contents(f.units.length, f.detachments.length);
      const what = `is gone from the site's index (it had ${had}; its \`data/\` file is kept as it was)`;
      flags.push({ kind: 'gone', factions: [f.name], what });
    }
  }

  // A new version and nothing else: what changed in it is likely what the scraper missed.
  // `||`, not `??`: `rules.version` is `''` when the site version didn't move.
  const bumped = rules?.version || sharedHead(changes) || changes[0]?.head[0];
  if (
    bumped &&
    (rules?.panels.length ?? 0) === 0 &&
    (changes.length > 0 || rules?.version) &&
    changes.every(versionOnly)
  ) {
    flags.push({
      kind: 'version-only',
      factions: [],
      what: `Only the version changed (${bumped}): no points, units, detachments or rules moved, so the scraper may be missing what the new version changed`,
    });
  }

  const first = (f: Flag) => f.factions[0] ?? '';
  return flags.sort(
    (a, b) =>
      ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) ||
      compareNames(first(a), first(b)) ||
      compareNames(a.what, b.what),
  );
}

/** The flags between two snapshots, from scratch: for the `mfm attention` command. */
export function needsAttention(
  before: Snapshot[],
  after: Snapshot[],
  opts: Pick<RenderOpts, 'meta'> = {},
): Flag[] {
  const changes = collectChanges(before, after);
  const rules = collectRules(opts.meta?.before, opts.meta?.after);
  return collectAttention(changes, rules, before, after, opts.meta);
}

/** One flag as a Markdown list item, the factions first. */
export function flagLine(f: Flag): string {
  const who = listing(f.factions.map((name) => `**${name}**`));
  if (!who) return `- ${f.what}`;
  return f.kind === 'gone' || f.kind === 'units-lost'
    ? `- ${who} ${f.what}`
    : `- ${who}: ${f.what}`;
}

/**
 * The warning at the top of the PR body, or `''` when nothing needs attention: a GitHub
 * alert, so it stands apart from the summary that follows, and at most `MAX_LISTED` lines.
 */
export function attentionSection(flags: Flag[]): string {
  if (flags.length === 0) return '';
  const lines = flags.slice(0, MAX_LISTED).map(flagLine);
  const more = flags.length - MAX_LISTED;
  if (more > 0) lines.push(`- …and ${more} more, which \`mfm attention\` lists`);
  const lead = `**Needs attention:** ${plural(flags.length, 'change')} that look${flags.length === 1 ? 's' : ''} more like the scraper misreading the site than GW changing it. Check ${flags.length === 1 ? 'it' : 'them'} against the site before merging.`;
  return ['> [!WARNING]', `> ${lead}`, '>', ...lines.map((l) => `> ${l}`)].join('\n');
}
