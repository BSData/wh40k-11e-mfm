import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { argv } from 'node:process';
import { fileURLToPath } from 'node:url';
import { factionFromYaml } from './emit.js';
import type { Faction, FactionContent } from './model.js';

/**
 * Turns two dataset snapshots (committed YAML vs. freshly scraped) into readable
 * change reports. One structured diff (`collectChanges`) feeds three renderers:
 *  - `changelog()` — the rich PR body (summary line, per-faction table, sections);
 *  - `changelogEntry()` — a Keep-a-Changelog release block for `DATA-CHANGELOG.md`;
 *  - `failuresReport()` — the per-faction parse errors for the workflow's issue.
 * All pure; the CLI at the bottom wires `changelog` to two directories. The YAML
 * git diff is the canonical record — these are the human-readable views of it.
 */

const sgn = (n: number): string => (n >= 0 ? `+${n}` : `${n}`);

/** "+2 -1", or "—" when nothing moved. */
const plusMinus = (a: number, r: number): string => {
  const parts: string[] = [];
  if (a) parts.push(`+${a}`);
  if (r) parts.push(`-${r}`);
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

/** Unit cost options keyed by `unit · tier · option`. */
function costRows(f: FactionContent): Map<string, Numeric> {
  const m = new Map<string, Numeric>();
  for (const u of f.units) {
    for (const t of u.pricing) {
      const tier = u.pricing.length > 1 ? ` [${t.range}]` : '';
      for (const c of t.costs) {
        const what = `${c.desc ?? `${c.models} model${c.models === 1 ? '' : 's'}`}${c.addon ? ' (add-on)' : ''}`;
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
      deltas.push({ display: row.display, from: prev.points, to: row.points });
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

/** The structured diff of one faction, shared by all renderers. */
interface FactionChanges {
  name: string;
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
  unitOther: string[];
  detOther: string[];
}

const emptyDiff = (): NumericDiff => ({ deltas: [], added: [], removed: [] });

/** Diff a faction present in both snapshots; `null` if nothing changed. */
function computeChanges(before: FactionContent, after: FactionContent): FactionChanges | null {
  const head: string[] = [];
  if (before.version !== after.version) head.push(`v${before.version} → v${after.version}`);
  if (before.parent !== after.parent)
    head.push(`parent ${before.parent ?? '—'} → ${after.parent ?? '—'}`);
  if (before.groupTitle !== after.groupTitle)
    head.push(`groupTitle ${before.groupTitle ?? '—'} → ${after.groupTitle ?? '—'}`);

  const ou = unitNames(before);
  const nu = unitNames(after);
  const od = detNames(before);
  const nd = detNames(after);
  const bothUnit = (n: string) => ou.has(n) && nu.has(n);
  const bothDet = (n: string) => od.has(n) && nd.has(n);

  const costs = diffNumeric(costRows(before), costRows(after), bothUnit);
  const wargear = diffNumeric(wargearRows(before), wargearRows(after), bothUnit);
  const enh = diffNumeric(enhRows(before), enhRows(after), bothDet);

  // Non-numeric attribute changes on entities present in both snapshots.
  const unitOther: string[] = [];
  const beforeUnits = new Map(before.units.map((u) => [u.name, u]));
  for (const u of after.units) {
    const p = beforeUnits.get(u.name);
    if (!p) continue;
    if ((p.role ?? '') !== (u.role ?? ''))
      unitOther.push(`${u.name} — role: ${p.role ?? '—'} → ${u.role ?? '—'}`);
    const pa = (p.attachTo ?? []).join(', ');
    const na = (u.attachTo ?? []).join(', ');
    if (pa !== na) unitOther.push(`${u.name} — attaches to: ${pa || '—'} → ${na || '—'}`);
  }
  const detOther: string[] = [];
  const beforeDets = new Map(before.detachments.map((d) => [d.name, d]));
  for (const d of after.detachments) {
    const p = beforeDets.get(d.name);
    if (!p) continue;
    if (p.dp !== d.dp) detOther.push(`${d.name} — DP: ${p.dp ?? '—'} → ${d.dp ?? '—'}`);
    if ((p.objective ?? '') !== (d.objective ?? ''))
      detOther.push(`${d.name} — objective: ${p.objective ?? '—'} → ${d.objective ?? '—'}`);
    if ((p.unique ?? '') !== (d.unique ?? ''))
      detOther.push(`${d.name} — unique: ${p.unique ?? '—'} → ${d.unique ?? '—'}`);
    const pe = new Map(p.enhancements.map((e) => [e.name, e]));
    for (const e of d.enhancements) {
      const x = pe.get(e.name);
      if (!x) continue;
      const pl = (x.leaderTo ?? []).join(', ');
      const nl = (e.leaderTo ?? []).join(', ');
      if (pl !== nl) detOther.push(`${d.name} · ${e.name} — leaderTo: ${pl || '—'} → ${nl || '—'}`);
    }
  }

  const changes: FactionChanges = {
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
    [costs, wargear, enh].every(
      (d) => d.deltas.length === 0 && d.added.length === 0 && d.removed.length === 0,
    );
  return empty ? null : changes;
}

/** A faction that appeared or disappeared entirely. */
function wholeFaction(f: FactionContent, status: 'added' | 'removed'): FactionChanges {
  return {
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
    unitOther: [],
    detOther: [],
  };
}

/** All faction changes between two snapshots: changed/added (by name), then removed. */
function collectChanges(before: FactionContent[], after: FactionContent[]): FactionChanges[] {
  const beforeBySlug = new Map(before.map((f) => [f.slug, f]));
  const afterBySlug = new Map(after.map((f) => [f.slug, f]));
  const out: FactionChanges[] = [];
  for (const f of [...after].sort((a, b) => a.name.localeCompare(b.name))) {
    const prev = beforeBySlug.get(f.slug);
    if (!prev) out.push(wholeFaction(f, 'added'));
    else {
      const c = computeChanges(prev, f);
      if (c) out.push(c);
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

/** Per-faction tallies used by the summary line and table. */
function tallies(c: FactionChanges) {
  if (c.status === 'added')
    return { uA: c.unitCount, uR: 0, dA: c.detCount, dR: 0, up: 0, down: 0, net: 0, changed: 0 };
  if (c.status === 'removed')
    return { uA: 0, uR: c.unitCount, dA: 0, dR: c.detCount, up: 0, down: 0, net: 0, changed: 0 };
  return {
    uA: c.unitsAdded.length,
    uR: c.unitsRemoved.length,
    dA: c.detsAdded.length,
    dR: c.detsRemoved.length,
    ...countDeltas(allDeltas(c)),
  };
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
    listBlock('Wargear', numericItems(c.wargear)),
    listBlock('Unit changes', c.unitOther),
    inlineBlock('Detachments added', c.detsAdded),
    inlineBlock('Detachments removed', c.detsRemoved),
    listBlock('Enhancements', numericItems(c.enh)),
    listBlock('Detachment changes', c.detOther),
  ].filter((b): b is string => b !== null);
  const heading = c.head.length > 0 ? `## ${c.name}  _(${c.head.join(', ')})_` : `## ${c.name}`;
  return `${heading}\n\n${blocks.join('\n\n')}`;
}

/** The summary line + per-faction table shown at the top of the changelog. */
function summary(changes: FactionChanges[]): string {
  const t = changes.map(tallies);
  const sum = (pick: (x: (typeof t)[number]) => number) => t.reduce((s, x) => s + pick(x), 0);
  const news = changes.filter((c) => c.status === 'added').length;
  const gone = changes.filter((c) => c.status === 'removed').length;
  const uA = sum((x) => x.uA);
  const uR = sum((x) => x.uR);
  const dA = sum((x) => x.dA);
  const dR = sum((x) => x.dR);
  const up = sum((x) => x.up);
  const down = sum((x) => x.down);
  const net = sum((x) => x.net);
  const changed = sum((x) => x.changed);

  const clauses = [`**${changes.length} faction${changes.length === 1 ? '' : 's'} changed**`];
  if (news) clauses.push(`${news} new`);
  if (gone) clauses.push(`${gone} removed`);
  if (uA || uR) clauses.push(`units ${plusMinus(uA, uR)}`);
  if (dA || dR) clauses.push(`detachments ${plusMinus(dA, dR)}`);
  if (changed)
    clauses.push(
      `${changed} point change${changed === 1 ? '' : 's'} (▲${up} ▼${down}, net ${sgn(net)} pts)`,
    );
  const line = clauses.join(' · ');

  if (changes.length < 2) return line;
  const rows = changes.map((c) => {
    if (c.status === 'added') return `| **${c.name}** | 🆕 new | | |`;
    if (c.status === 'removed') return `| **${c.name}** | 🗑 removed | | |`;
    const x = tallies(c);
    const pts = x.changed > 0 ? `▲${x.up} ▼${x.down}` : '—';
    return `| ${c.name} | ${plusMinus(x.uA, x.uR)} | ${plusMinus(x.dA, x.dR)} | ${pts} |`;
  });
  return `${line}\n\n| Faction | Units | Detachments | Points |\n| --- | --- | --- | --- |\n${rows.join('\n')}`;
}

/** Build a full Markdown changelog from two faction snapshots keyed by slug. */
export function changelog(before: FactionContent[], after: FactionContent[]): string {
  const changes = collectChanges(before, after);
  if (changes.length === 0) return 'No changes detected.\n';
  return `${summary(changes)}\n\n---\n\n${changes.map(renderSection).join('\n\n')}\n`;
}

// ---- Keep-a-Changelog entry (DATA-CHANGELOG.md) -------------------------------

/**
 * One dated Keep-a-Changelog release block, items grouped under Added / Changed /
 * Removed and prefixed by faction. `''` when nothing changed. Prepended to
 * `DATA-CHANGELOG.md` by `scripts/update-data-changelog.ts` on each scrape PR.
 */
export function changelogEntry(
  before: FactionContent[],
  after: FactionContent[],
  opts: { date: string },
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
    for (const o of [...c.unitOther, ...c.detOther]) changedItems.push(`${fx}: ${o}`);
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

  const version = after[0]?.version;
  const heading = version ? `## [${opts.date}] — MFM v${version}` : `## [${opts.date}]`;
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

// CLI: tsx src/diff.ts <beforeDir> <afterDir>
const isMain = argv[1] !== undefined && fileURLToPath(import.meta.url) === argv[1];
if (isMain) {
  const [beforeDir, afterDir] = argv.slice(2);
  if (!beforeDir || !afterDir) {
    console.error('usage: tsx src/diff.ts <beforeDir> <afterDir>');
    process.exit(2);
  }
  const before = loadFactionDir(beforeDir);
  const after = loadFactionDir(afterDir);
  process.stdout.write(changelog(before, after));
}
