import { Document, parse, stringify, visit } from 'yaml';
import {
  type CostOption,
  type Detachment,
  Faction,
  type FactionContent,
  type Unit,
} from './model.js';

/**
 * Deterministic YAML serialization. Output ordering is fixed (entities sorted by
 * name, fixed key order) so that a points change produces the smallest possible
 * git diff — the dataset doubles as the change history. Cost order is preserved
 * from the source (it is meaningful). Leaf cost/wargear/enhancement maps are
 * rendered in flow style (`{ models: 1, points: 50 }`) for compact readability.
 */

const STRINGIFY_OPTS = { lineWidth: 0, sortMapEntries: false } as const;

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function orderCost(c: CostOption): CostOption {
  const cost: CostOption = { models: c.models, points: c.points };
  if (c.desc !== undefined) cost.desc = c.desc;
  if (c.addon) cost.addon = true;
  return cost;
}

function orderDetachments(ds: Detachment[]) {
  return [...ds].sort(byName).map((d) => ({
    name: d.name,
    dp: d.dp,
    objective: d.objective,
    enhancements: [...d.enhancements].sort(byName),
  }));
}

function orderUnits(us: Unit[]): Unit[] {
  return [...us].sort(byName).map((u) => {
    const unit: Unit = {
      name: u.name,
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

/** Canonical content object (sorted, fixed key order), excluding provenance. */
function orderContent(c: FactionContent): FactionContent {
  return {
    name: c.name,
    slug: c.slug,
    version: c.version,
    detachments: orderDetachments(c.detachments),
    units: orderUnits(c.units),
  };
}

/**
 * A stable fingerprint of a faction's *content* (ignores `firstSeen`). Two scrapes
 * with identical data produce the same key, which is how the CLI decides whether
 * to keep the existing `firstSeen` date or stamp a new one.
 */
export function contentKey(c: FactionContent): string {
  return JSON.stringify(orderContent(c));
}

/** Serialize a faction to canonical YAML. `firstSeen` sits just under `version`. */
export function factionToYaml(f: Faction): string {
  const { name, slug, version, detachments, units } = orderContent(f);
  const doc = new Document({ name, slug, version, firstSeen: f.firstSeen, detachments, units });
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
  const doc: Record<string, unknown> = { version: meta.version, lastUpdated: meta.lastUpdated };
  if (meta.notes) doc.notes = meta.notes;
  doc.factions = [...meta.factions].sort();
  return stringify(doc, STRINGIFY_OPTS);
}

export function metaFromYaml(text: string): SiteMeta {
  return parse(text) as SiteMeta;
}
