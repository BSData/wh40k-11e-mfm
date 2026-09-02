import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { factionFromYaml, metaFromYaml } from './emit.js';
import type { CostOption, Faction, FactionContent, PricingTier, Unit } from './model.js';

/**
 * Turns two dataset snapshots (committed YAML vs. freshly scraped) into readable
 * change reports. One structured diff (`collectChanges`) feeds three renderers here:
 *  - `changelog()` — the rich PR body (dated title, summary line, per-faction table,
 *    and the sections, folded away once they get long);
 *  - `changelogEntry()` — a Keep-a-Changelog release block for `DATA-CHANGELOG.md`;
 *  - `failuresReport()` — the per-faction parse errors for the workflow's issue.
 * and a fourth next door: `announcement()` in `src/discord.ts` builds the webhook embed
 * from the same `collectChanges`/`tallies`/`totals` — exported for it, so the two
 * summaries cannot drift.
 * `updateWindow()`/`updateTitle()` date an update from the data itself, which is what
 * lets the sticky update PR keep its start date across force-pushes.
 * All pure; the CLI at the bottom wires `changelog` to two directories. The YAML
 * git diff is the canonical record — these are the human-readable views of it.
 */

export const sgn = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/**
 * A snapshot entry: parsed faction content plus the `firstSeen` stamp it carries when
 * loaded from disk (bare parser output has none).
 */
export type Snapshot = FactionContent & { firstSeen?: string };

/** "+2 -1 ~7" — added / removed / changed in place — or "—" when nothing moved. */
const counts = (added: number, removed: number, changed = 0): string => {
  const parts: string[] = [];
  if (added) parts.push(`+${added}`);
  if (removed) parts.push(`-${removed}`);
  if (changed) parts.push(`~${changed}`);
  return parts.length > 0 ? parts.join(' ') : '—';
};

const unitNames = (f: FactionContent) => new Set(f.units.map((u) => u.name));
const detNames = (f: FactionContent) => new Set(f.detachments.map((d) => d.name));
const onlyIn = <T>(a: Set<T>, b: Set<T>) => [...a].filter((x) => !b.has(x)).sort();

/** A keyed numeric value (a unit cost option, a wargear item, or an enhancement). */
interface Numeric {
  display: string;
  points: number;
  entity: string; // owning unit or detachment, so we can skip lines of added/removed entities
}

/** What a cost option is *for* — "3 models", a named option, an add-on. */
const costLabel = (c: CostOption): string =>
  `${c.desc ?? `${c.models} model${c.models === 1 ? '' : 's'}`}${c.addon ? ' (add-on)' : ''}`;

/** Unit cost options keyed by `unit · tier · option`. */
function costRows(f: FactionContent): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const u of f.units) {
    for (const t of u.pricing) {
      const tier = u.pricing.length > 1 ? ` [${t.range}]` : '';
      for (const c of t.costs) {
        const what = costLabel(c);
        m.set(`${u.name} ${t.range} ${what}`, {
          entity: u.name,
          points: c.points,
          display: `${u.name} — ${what}${tier}`,
        });
      }
    }
  }
  return m;
}

/** Wargear items keyed by `unit · item`. */
function wargearRows(f: FactionContent): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const u of f.units) {
    for (const w of u.wargear ?? []) {
      m.set(`${u.name} ${w.item}`, {
        entity: u.name,
        points: w.points,
        display: `${u.name} — ${w.item}`,
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

interface Delta {
  display: string;
  from: number;
  to: number;
  /** Owning unit/detachment, so the summary table can count entities touched. */
  entity: string;
}
interface NumericDiff {
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
      Math.abs(b.to - b.from) - Math.abs(a.to - a.from) || a.display.localeCompare(b.display),
  );
  const byName = (a: Numeric, b: Numeric) => a.display.localeCompare(b.display);
  return { deltas, added: addedRows.sort(byName), removed: removedRows.sort(byName) };
}

/** A non-numeric attribute change, keyed by the entity it belongs to. */
interface Attr {
  entity: string;
  text: string;
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
interface Retier {
  unit: string;
  text: string;
}

/** Every option's points across a unit's tiers, in tier order, keyed by option label. */
function pricesByOption(pricing: PricingTier[]): Map<string, number[]> {
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
const tierRanges = (u: Unit): string[] => u.pricing.map((t) => t.range);

/**
 * One line describing a re-tiering: the tiers before and after, then each option's old
 * price and its new price in every tier — `5 models: 275 → 280 / 310`.
 */
function describeRetier(before: Unit, after: Unit): Retier {
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
  const tiers = `${tierRanges(before).join(' + ')} → ${tierRanges(after).join(' + ')}`;
  return { unit: after.name, text: `${after.name} — re-tiered ${tiers}; ${rows.join(' · ')}` };
}

/** The structured diff of one faction, shared by all renderers. */
export interface FactionChanges {
  slug: string;
  name: string;
  /** The scraped snapshot's `firstSeen` — the day this content appeared. */
  firstSeen?: string;
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

  const ou = unitNames(before);
  const nu = unitNames(after);
  const od = detNames(before);
  const nd = detNames(after);
  const bothUnit = (n: string) => ou.has(n) && nu.has(n);
  const bothDet = (n: string) => od.has(n) && nd.has(n);

  // Units whose tier structure changed are described whole, and kept out of the cost
  // diff — every one of their keys moved, so row-by-row it is all noise.
  const beforeByName = new Map(before.units.map((u) => [u.name, u]));
  const retiered: Retier[] = [];
  for (const u of after.units) {
    const p = beforeByName.get(u.name);
    if (p && tierRanges(p).join('|') !== tierRanges(u).join('|'))
      retiered.push(describeRetier(p, u));
  }
  const wasRetiered = new Set(retiered.map((r) => r.unit));
  const costUnit = (n: string) => bothUnit(n) && !wasRetiered.has(n);

  const costs = diffNumeric(costRows(before), costRows(after), costUnit);
  const wargear = diffNumeric(wargearRows(before), wargearRows(after), bothUnit);
  const enh = diffNumeric(enhRows(before), enhRows(after), bothDet);

  // Non-numeric attribute changes on entities present in both snapshots.
  const unitOther: Attr[] = [];
  const beforeUnits = new Map(before.units.map((u) => [u.name, u]));
  for (const u of after.units) {
    const p = beforeUnits.get(u.name);
    if (!p) continue;
    const note = (text: string) => unitOther.push({ entity: u.name, text: `${u.name} — ${text}` });
    for (const grant of ['leaderTo', 'supportTo'] as const) {
      const pa = (p[grant] ?? []).join(', ');
      const na = (u[grant] ?? []).join(', ');
      if (pa !== na) note(`${grant}: ${pa || '—'} → ${na || '—'}`);
    }
  }
  const detOther: Attr[] = [];
  const beforeDets = new Map(before.detachments.map((d) => [d.name, d]));
  for (const d of after.detachments) {
    const p = beforeDets.get(d.name);
    if (!p) continue;
    const note = (text: string) => detOther.push({ entity: d.name, text });
    if (p.dp !== d.dp) note(`${d.name} — DP: ${p.dp ?? '—'} → ${d.dp ?? '—'}`);
    const po = p.objectives.join(', ');
    const no = d.objectives.join(', ');
    if (po !== no) note(`${d.name} — objectives: ${po || '—'} → ${no || '—'}`);
    if ((p.unique ?? '') !== (d.unique ?? ''))
      note(`${d.name} — unique: ${p.unique ?? '—'} → ${d.unique ?? '—'}`);
    const pe = new Map(p.enhancements.map((e) => [e.name, e]));
    for (const e of d.enhancements) {
      const x = pe.get(e.name);
      if (!x) continue;
      for (const grant of ['leaderTo', 'supportTo'] as const) {
        const pl = (x[grant] ?? []).join(', ');
        const nl = (e[grant] ?? []).join(', ');
        if (pl !== nl) note(`${d.name} · ${e.name} — ${grant}: ${pl || '—'} → ${nl || '—'}`);
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
    unitsAdded: onlyIn(nu, ou),
    unitsRemoved: onlyIn(ou, nu),
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
  // Carried only when present: bare parser content (tests, one-off diffs) has no stamp.
  const seen = (f: Snapshot) => (f.firstSeen ? { firstSeen: f.firstSeen } : {});
  for (const f of [...after].sort((a, b) => a.name.localeCompare(b.name))) {
    const prev = beforeBySlug.get(f.slug);
    if (!prev) out.push({ ...wholeFaction(f, 'added'), ...seen(f) });
    else {
      const c = computeChanges(prev, f);
      if (c) out.push({ ...c, ...seen(f) });
    }
  }
  for (const f of [...before].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!afterBySlug.has(f.slug)) out.push(wholeFaction(f, 'removed'));
  }
  return out;
}

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
 * Every faction's tallies summed — the numbers a whole-update summary is built from.
 * Shared by the changelog's summary line and the Discord embed so the two can't report
 * different totals for the same update.
 */
export function totals(changes: FactionChanges[]) {
  const t = changes.map(tallies);
  const sum = (pick: (x: (typeof t)[number]) => number) => t.reduce((s, x) => s + pick(x), 0);
  return {
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

// ---- Rich changelog (PR body) -------------------------------------------------

const deltaLine = (d: Delta) => `${d.display}: ${d.from} → ${d.to} pts (**${sgn(d.to - d.from)}**)`;
const numericItems = (d: NumericDiff): string[] => [
  ...d.deltas.map(deltaLine),
  ...d.added.map((r) => `➕ ${r.display}: ${r.points} pts`),
  ...d.removed.map((r) => `➖ ${r.display}: was ${r.points} pts`),
];

/** Render `**Label:** item, item` (inline) only when there are items. */
const inlineBlock = (label: string, items: string[]): string | null =>
  items.length > 0 ? `**${label}:** ${items.join(', ')}` : null;
/** Render `**Label:**` followed by a bullet list, only when there are items. */
const listBlock = (label: string, items: string[]): string | null =>
  items.length > 0 ? `**${label}:**\n${items.map((i) => `- ${i}`).join('\n')}` : null;

function renderSection(c: FactionChanges): string {
  if (c.status === 'added')
    return `## ${c.name}\n\n🆕 **New faction** — ${c.unitCount} units, ${c.detCount} detachments`;
  if (c.status === 'removed') return `## ${c.name}\n\n🗑 **Removed faction**`;

  const blocks = [
    inlineBlock('Units added', c.unitsAdded),
    inlineBlock('Units removed', c.unitsRemoved),
    listBlock('Unit points', numericItems(c.costs)),
    listBlock(
      'Unit pricing re-tiered',
      c.retiered.map((r) => r.text),
    ),
    listBlock('Wargear', numericItems(c.wargear)),
    listBlock(
      'Unit changes',
      c.unitOther.map((o) => o.text),
    ),
    inlineBlock('Detachments added', c.detsAdded),
    inlineBlock('Detachments removed', c.detsRemoved),
    listBlock('Enhancements', numericItems(c.enh)),
    listBlock(
      'Detachment changes',
      c.detOther.map((o) => o.text),
    ),
  ].filter((b): b is string => b !== null);
  const heading = c.head.length > 0 ? `## ${c.name}  _(${c.head.join(', ')})_` : `## ${c.name}`;
  // A version/parent bump alone leaves nothing to list — say so, rather than emitting
  // a bare heading that reads like a section the renderer forgot to fill in.
  const body = blocks.length > 0 ? blocks.join('\n\n') : '_No unit or detachment changes._';
  return `${heading}\n\n${body}`;
}

/** The table's Points cell: "▲3 ▼1 (-25)", or "—" when nothing was repriced. */
const pointsCell = (t: { up: number; down: number; net: number }): string => {
  const arrows = [t.up ? `▲${t.up}` : '', t.down ? `▼${t.down}` : ''].filter(Boolean);
  return arrows.length > 0 ? `${arrows.join(' ')} (${sgn(t.net)})` : '—';
};

const LEGEND =
  '_`+` added · `-` removed · `~` changed in place · ▲ raised · ▼ cut (net in brackets)_';

/** The summary line + per-faction table shown at the top of the changelog. */
function summary(changes: FactionChanges[]): string {
  const { news, gone, uA, uR, uC, dA, dR, dC, up, down, net, changed, retiered } = totals(changes);
  // An MFM revision bumps every faction's version at once. That is a fact about the
  // update, not about any one faction, so when the note is universal it belongs in this
  // line — tagging it onto rows instead would read as "these are the ones that bumped".
  const shared = sharedHead(changes);

  const clauses = [`**${changes.length} faction${changes.length === 1 ? '' : 's'} changed**`];
  if (shared) clauses.push(`all ${shared}`);
  if (news) clauses.push(`${news} new`);
  if (gone) clauses.push(`${gone} removed`);
  if (uA || uR || uC) clauses.push(`units ${counts(uA, uR, uC)}`);
  if (dA || dR || dC) clauses.push(`detachments ${counts(dA, dR, dC)}`);
  if (changed)
    clauses.push(
      `${changed} point change${changed === 1 ? '' : 's'} (▲${up} ▼${down}, net ${sgn(net)} pts)`,
    );
  if (retiered) clauses.push(`${retiered} unit${retiered === 1 ? '' : 's'} re-tiered`);
  const line = clauses.join(' · ');

  if (changes.length < 2) return line;
  const rows = changes.map((c) => {
    const x = tallies(c);
    const mark = c.status === 'added' ? ' 🆕' : c.status === 'removed' ? ' 🗑' : '';
    // A version/parent note the faction does *not* share with the rest is part of what
    // changed for it, so it belongs in its row — a row with nothing else in it then has
    // its reason for being listed. When every faction carries the same note it is in
    // the summary line above instead, and repeating it on all 30 rows would be noise.
    const note = !shared && c.head.length > 0 ? ` _(${c.head.join(', ')})_` : '';
    const name = `${mark ? `**${c.name}**` : c.name}${mark}${note}`;
    return `| ${name} | ${counts(x.uA, x.uR, x.uC)} | ${counts(x.dA, x.dR, x.dC)} | ${pointsCell(x)} |`;
  });
  const table = `| Faction | Units | Detachments | Points |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
  return `${line}\n\n${table}\n\n${LEGEND}`;
}

/** Detail bodies longer than this fold into a collapsed `<details>` block. */
const FOLD_AFTER_LINES = 50;

const BLURB =
  '_Automated Munitorum Field Manual scrape. The YAML diff is canonical; this is the readable summary._';

/**
 * Collapse a long per-faction detail body behind a `<details>` toggle, so the summary
 * and table stay readable without scrolling past hundreds of bullets. GitHub renders
 * Markdown inside `<details>` as long as a blank line follows `<summary>`.
 */
function fold(detail: string, factions: number): string {
  const lines = detail.split('\n').length;
  if (lines <= FOLD_AFTER_LINES) return detail;
  const what = `${factions} faction${factions === 1 ? '' : 's'}, ${lines} lines`;
  return `<details>\n<summary><strong>Per-faction detail</strong> — ${what}</summary>\n\n${detail}\n\n</details>`;
}

/** Build a full Markdown changelog (the PR body) from two faction snapshots. */
export function changelog(before: Snapshot[], after: Snapshot[], opts: RenderOpts = {}): string {
  const changes = collectChanges(before, after);
  if (changes.length === 0) return 'No changes detected.\n';
  const detail = fold(changes.map(renderSection).join('\n\n'), changes.length);
  const head = `# ${updateTitle(before, after, opts)}\n\n${BLURB}`;
  return `${head}\n\n${summary(changes)}\n\n---\n\n${detail}\n`;
}

// ---- Naming an update: MFM version + dates ------------------------------------

export interface RenderOpts {
  /** Today, `YYYY-MM-DD` UTC. Defaults to the real clock; pass it for determinism. */
  today?: string;
  /** The MFM version this update lands on; `loadVersion()` reads it from `meta.yaml`. */
  version?: string;
}

/**
 * The MFM version an update lands on: the site-wide one from `meta.yaml` when the
 * caller has it, otherwise the version most factions carry (they move together, but a
 * page can lag a revision behind — the majority is the update's version, not whichever
 * faction happens to sort first). Ties go to the higher version, so the answer does not
 * depend on directory order.
 */
function updateVersion(after: Snapshot[], opts: RenderOpts): string | undefined {
  if (opts.version) return opts.version;
  const tally = new Map<string, number>();
  for (const f of after) tally.set(f.version, (tally.get(f.version) ?? 0) + 1);
  const ranked = [...tally].sort((a, b) => b[1] - a[1] || b[0].localeCompare(a[0]));
  return ranked[0]?.[0];
}

/** The site-wide MFM version recorded in a snapshot's `meta.yaml`, when it has one. */
export function loadVersion(dir: string): string | undefined {
  const path = join(dir, 'meta.yaml');
  if (!existsSync(path)) return undefined;
  try {
    return metaFromYaml(readFileSync(path, 'utf8')).version;
  } catch {
    return undefined; // A snapshot without usable meta just goes unnamed.
  }
}

/**
 * The days a change set spans, read from the `firstSeen` stamps of the factions in it.
 * The scrape PR is sticky — a later run force-pushes onto the same branch — so an
 * update is not a single day's event. Taking the dates from the data instead of
 * stamping "now" on every run keeps the first day stable across re-scrapes that find
 * nothing new, and widens to a range only once a later scrape genuinely adds
 * something. Entries with no stamp (a removed faction, or bare parser content) count
 * as today.
 */
export function updateWindow(
  before: Snapshot[],
  after: Snapshot[],
  opts: RenderOpts = {},
): { from: string; to: string } {
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  const dates = collectChanges(before, after).map((c) => c.firstSeen ?? today);
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
 * widening as days accrue.
 */
export function updateTitle(before: Snapshot[], after: Snapshot[], opts: RenderOpts = {}): string {
  const version = updateVersion(after, opts);
  const what = version ? `MFM v${version} update` : 'MFM data update';
  return `${what} — ${windowLabel(updateWindow(before, after, opts))}`;
}

// ---- Keep-a-Changelog entry (DATA-CHANGELOG.md) -------------------------------

/**
 * One dated Keep-a-Changelog release block, items grouped under Added / Changed /
 * Removed and prefixed by faction. `''` when nothing changed. Prepended to
 * `DATA-CHANGELOG.md` by `scripts/update-data-changelog.ts` on each scrape PR.
 * `date` defaults to the update's own window (see `updateWindow`), so a re-scrape
 * that finds nothing new rewrites the file byte-identically instead of churning
 * the heading to today and force-pushing the sticky PR.
 */
export function changelogEntry(
  before: Snapshot[],
  after: Snapshot[],
  opts: RenderOpts & { date?: string } = {},
): string {
  const changes = collectChanges(before, after);
  if (changes.length === 0) return '';

  const addedItems: string[] = [];
  const changedItems: string[] = [];
  const removedItems: string[] = [];
  for (const c of changes) {
    const fx = `**${c.name}**`;
    if (c.status === 'added') {
      addedItems.push(`${fx}: new faction (${c.unitCount} units, ${c.detCount} detachments)`);
      continue;
    }
    if (c.status === 'removed') {
      removedItems.push(`${fx}: removed faction`);
      continue;
    }
    for (const u of c.unitsAdded) addedItems.push(`${fx}: new unit ${u}`);
    for (const d of c.detsAdded) addedItems.push(`${fx}: new detachment ${d}`);
    for (const r of [...c.costs.added, ...c.wargear.added, ...c.enh.added])
      addedItems.push(`${fx}: ${r.display} (${r.points} pts)`);

    for (const u of c.unitsRemoved) removedItems.push(`${fx}: removed unit ${u}`);
    for (const d of c.detsRemoved) removedItems.push(`${fx}: removed detachment ${d}`);
    for (const r of [...c.costs.removed, ...c.wargear.removed, ...c.enh.removed])
      removedItems.push(`${fx}: removed ${r.display} (was ${r.points} pts)`);

    for (const d of allDeltas(c))
      changedItems.push(`${fx}: ${d.display}: ${d.from} → ${d.to} pts (${sgn(d.to - d.from)})`);
    for (const r of c.retiered) changedItems.push(`${fx}: ${r.text}`);
    for (const o of [...c.unitOther, ...c.detOther]) changedItems.push(`${fx}: ${o.text}`);
    for (const h of c.head) changedItems.push(`${fx}: ${h}`);
  }

  const block = (title: string, items: string[]): string | null =>
    items.length > 0
      ? `### ${title}\n${items
          .sort()
          .map((i) => `- ${i}`)
          .join('\n')}`
      : null;
  const body = [
    block('Added', addedItems),
    block('Changed', changedItems),
    block('Removed', removedItems),
  ]
    .filter((b): b is string => b !== null)
    .join('\n\n');

  const date = opts.date ?? windowLabel(updateWindow(before, after, opts));
  const version = updateVersion(after, opts);
  const heading = version ? `## [${date}] — MFM v${version}` : `## [${date}]`;
  return `${heading}\n\n${body}\n`;
}

// ---- Failure report (error issue) --------------------------------------------

/** Render the per-faction parse failures for the scrape workflow's error issue. */
export function failuresReport(failures: { slug: string; error: string }[]): string {
  if (failures.length === 0) return '';
  const blocks = [...failures]
    .sort((a, b) => a.slug.localeCompare(b.slug))
    .map((f) => `### ${f.slug}\n\n\`\`\`\n${f.error.trim()}\n\`\`\``);
  const n = failures.length;
  return `## ${n} faction${n === 1 ? '' : 's'} failed to parse\n\n${blocks.join('\n\n')}`;
}

/** Load every `<faction>.yaml` (excluding meta.yaml) from a directory. */
export function loadFactionDir(dir: string): Faction[] {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && f !== 'meta.yaml')
    .map((f) => factionFromYaml(readFileSync(join(dir, f), 'utf8')));
}

// CLI: tsx src/diff.ts <beforeDir> <afterDir> [--title-file <path>]
const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];
if (isMain) {
  const args = argv.slice(2);
  const at = args.indexOf('--title-file');
  const titleFile = at === -1 ? undefined : args[at + 1];
  const [beforeDir, afterDir] = at === -1 ? args : [...args.slice(0, at), ...args.slice(at + 2)];
  if (!beforeDir || !afterDir || (at !== -1 && !titleFile)) {
    console.error('usage: tsx src/diff.ts <beforeDir> <afterDir> [--title-file <path>]');
    process.exit(2);
  }
  const before = loadFactionDir(beforeDir);
  const after = loadFactionDir(afterDir);
  const version = loadVersion(afterDir);
  const opts = version ? { version } : {};
  // The workflow feeds the title to the PR and the commit alongside the body.
  if (titleFile) writeFileSync(titleFile, `${updateTitle(before, after, opts)}\n`);
  process.stdout.write(changelog(before, after, opts));
}
