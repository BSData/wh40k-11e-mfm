import { Document, parse, stringify, visit } from 'yaml';
import {
  type CostOption,
  type Detachment,
  Faction,
  type FactionContent,
  type Unit,
} from './model.js';

/**
 * Deterministic YAML serialization. Top-level key order is fixed; leaf
 * cost/wargear/enhancement maps render in flow style (`{ models: 1, points: 50 }`)
 * for compact readability. Cost order is always preserved from the source.
 *
 * Entity ordering (units, detachments, enhancements) is selectable via `OrderMode`:
 * - `'name'` (default): alphabetical, so a points change produces the smallest possible
 *   git diff — the dataset doubles as the change history.
 * - `'page'`: the source page order, faithful to how the MFM lays the entities out
 *   (related entries stay grouped) at the cost of churn if the site reorders a page.
 */

/** How to order entity lists (units, detachments, enhancements) in the output. */
export type OrderMode = 'name' | 'page';

const STRINGIFY_OPTS = { lineWidth: 0, sortMapEntries: false } as const;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

/** Order a named list by `OrderMode`: alphabetical for `'name'`, source order for `'page'`. */
const ordered = <T extends { name: string }>(items: T[], order: OrderMode): T[] =>
  order === 'name' ? [...items].sort(byName) : items;

function orderCost(c: CostOption): CostOption {
  const cost: CostOption = { models: c.models, points: c.points };
  if (c.desc !== undefined) cost.desc = c.desc;
  if (c.addon) cost.addon = true;
  return cost;
}

function orderDetachments(ds: Detachment[], order: OrderMode): Detachment[] {
  return ordered(ds, order).map((d) => {
    // Build with a fixed key order: name, dp, objective, [unique], enhancements.
    const head: Pick<Detachment, 'name' | 'dp' | 'objective'> = {
      name: d.name,
      dp: d.dp,
      objective: d.objective,
    };
    return {
      ...head,
      ...(d.unique !== undefined ? { unique: d.unique } : {}),
      enhancements: ordered(d.enhancements, order).map((e) => ({
        name: e.name,
        points: e.points,
        ...(e.leaderTo !== undefined ? { leaderTo: e.leaderTo } : {}),
        ...(e.supportTo !== undefined ? { supportTo: e.supportTo } : {}),
      })),
    };
  });
}

function orderUnits(us: Unit[], order: OrderMode): Unit[] {
  return ordered(us, order).map((u) => {
    const unit: Unit = {
      name: u.name,
      ...(u.groupTitle !== undefined ? { groupTitle: u.groupTitle } : {}),
      pricing: u.pricing.map((t) => ({
        range: t.range,
        label: t.label,
        costs: t.costs.map(orderCost),
      })),
    };
    if (u.role) unit.role = u.role;
    if (u.attachTo) unit.attachTo = u.attachTo;
    if (u.wargear) unit.wargear = u.wargear.map((w) => ({ item: w.item, points: w.points }));
    if (u.legends) unit.legends = true;
    return unit;
  });
}

/** Canonical content object (ordered per `order`, fixed key order), excluding provenance. */
function orderContent(c: FactionContent, order: OrderMode = 'name'): FactionContent {
  return {
    name: c.name,
    slug: c.slug,
    version: c.version,
    ...(c.parent !== undefined ? { parent: c.parent } : {}),
    detachments: orderDetachments(c.detachments, order),
    units: orderUnits(c.units, order),
  };
}

/**
 * A stable fingerprint of a faction's *content* (ignores `firstSeen`). Two scrapes
 * with identical data produce the same key, which is how the CLI decides whether
 * to keep the existing `firstSeen` date or stamp a new one. `order` must match the
 * mode the file was written with so a re-scrape compares like for like.
 */
export function contentKey(c: FactionContent, order: OrderMode = 'name'): string {
  return JSON.stringify(orderContent(c, order));
}

/** Serialize a faction to canonical YAML. `firstSeen` sits just under `version`. */
export function factionToYaml(f: Faction, order: OrderMode = 'name'): string {
  const { name, slug, version, parent, detachments, units } = orderContent(f, order);
  const doc = new Document({
    name,
    slug,
    version,
    firstSeen: f.firstSeen,
    ...(parent !== undefined ? { parent } : {}),
    detachments,
    units,
  });
  // Compact leaf maps (cost options, wargear, enhancements) onto one line.
  visit(doc, {
    Map(_, node) {
      if (node.has('points')) node.flow = true;
    },
  });
  return doc.toString(STRINGIFY_OPTS);
}

/** Parse canonical YAML back into a validated, canonicalized faction. */
export function factionFromYaml(text: string): Faction {
  const f = Faction.parse(parse(text));
  return { ...orderContent(f), firstSeen: f.firstSeen };
}

export type SiteMeta = {
  version: string;
  lastUpdated: string;
  /** The expandable "Welcome…" help text, when captured via the browser. */
  notes?: string;
  factions: string[];
};

/** Metadata index. `lastUpdated` is stable on no-op scrapes (max of firstSeen). */
export function metaToYaml(meta: SiteMeta): string {
  const doc = {
    version: meta.version,
    lastUpdated: meta.lastUpdated,
    ...(meta.notes ? { notes: meta.notes } : {}),
    factions: [...meta.factions].sort(),
  };
  return stringify(doc, STRINGIFY_OPTS);
}

export function metaFromYaml(text: string): SiteMeta {
  return parse(text) as SiteMeta;
}
