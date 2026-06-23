import { z } from 'zod';

/**
 * Domain model + runtime contract for scraped MFM data.
 *
 * These zod schemas are the single source of truth: the parser must produce
 * values that pass `.parse()`, and the CLI validates every faction against them
 * before writing YAML. A structural change on the source site therefore surfaces
 * as a loud, located validation error instead of silently-wrong data.
 *
 * See specs/data-model.md for the prose contract.
 */

/**
 * One cost option. `models` is the total model count; `points` its cost.
 * `desc` is present only when the source row isn't a plain "N models" line —
 * i.e. named/composite compositions ("3 Wolf Guard Headtakers, 3 Hunting Wolves")
 * or add-ons — and disambiguates rows that share a model count. `addon: true`
 * marks "+"-prefixed extras (e.g. "+ 1 Invader ATV") added on top of a base option.
 */
export const CostOption = z.object({
  models: z.number().int().nonnegative(),
  points: z.number().int().nonnegative(),
  desc: z.string().min(1).optional(),
  addon: z.literal(true).optional(),
});
export type CostOption = z.infer<typeof CostOption>;

/** Interval of unit copies a tier prices: `[1,2]` (closed) or `[3,)` (unbounded). */
const RANGE_RE = /^\[\d+,(?:\d+\]|\))$/;

/**
 * A pricing tier. `range` is the interval of unit copies it applies to in
 * mathematical notation. `label` is the site's verbatim heading, kept for human
 * reference (secondary to `range`). Tier order is preserved as parsed.
 */
export const PricingTier = z.object({
  range: z.string().regex(RANGE_RE),
  label: z.string().min(1),
  costs: z.array(CostOption).min(1),
});
export type PricingTier = z.infer<typeof PricingTier>;

/** A wargear item with a per-item points cost, added on top of the unit's cost. */
export const Wargear = z.object({
  item: z.string().min(1),
  points: z.number().int().nonnegative(),
});
export type Wargear = z.infer<typeof Wargear>;

export const Unit = z.object({
  name: z.string().min(1),
  pricing: z.array(PricingTier).min(1),
  /** "leader" or "support" if the unit has that ability (lists `attachTo`). */
  role: z.enum(['leader', 'support']).optional(),
  /** Units this Leader/Support can be attached to. */
  attachTo: z.array(z.string().min(1)).optional(),
  wargear: z.array(Wargear).optional(),
  /** True for Legends (deprecated) units; absent for current ones. */
  legends: z.literal(true).optional(),
});
export type Unit = z.infer<typeof Unit>;

export const Enhancement = z.object({
  name: z.string().min(1),
  points: z.number().int().nonnegative(),
  /**
   * Units this enhancement unlocks the Leader ability for (the "LEADER:" list shown
   * beside it): buying the enhancement grants its bearer the ability to lead these.
   */
  leaderTo: z.array(z.string().min(1)).optional(),
});
export type Enhancement = z.infer<typeof Enhancement>;

export const Detachment = z.object({
  name: z.string().min(1),
  /** The detachment's "detachment points" cost (e.g. `2DP` → 2), or null if absent. */
  dp: z.number().int().nonnegative().nullable(),
  objective: z.string().nullable(),
  /** Sub-faction keyword this detachment is restricted to (the "UNIQUE: X" banner). */
  unique: z.string().min(1).optional(),
  enhancements: z.array(Enhancement),
});
export type Detachment = z.infer<typeof Detachment>;

/** The scraped content of a faction page (no provenance fields). Parser output. */
export const FactionContent = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  /**
   * Parent army a sub-faction belongs to (e.g. "Space Marines" for Black Templars),
   * from the page's army-group title — but only when that title names another known
   * faction. Absent for top-level factions and for army-group titles that are not
   * factions (those go to `groupTitle`).
   */
  parent: z.string().min(1).optional(),
  /**
   * The page's army-group title when it is *not* a parent faction — a sub-army or
   * army-rule heading (e.g. "Harlequins" on Aeldari, "Blood Legions" on World Eaters).
   * Mutually exclusive with `parent`. Absent when the page has no such title.
   */
  groupTitle: z.string().min(1).optional(),
  detachments: z.array(Detachment),
  units: z.array(Unit).min(1),
});
export type FactionContent = z.infer<typeof FactionContent>;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A faction file = its content plus `firstSeen`: the date this exact content was
 * first observed. It is kept stable across no-op scrapes and only advances when
 * the content actually changes, so it records when each set of values took effect.
 */
export const Faction = FactionContent.extend({
  firstSeen: z.string().regex(ISO_DATE),
});
export type Faction = z.infer<typeof Faction>;

export const FactionSummary = z.object({
  slug: z.string().min(1),
  name: z.string().min(1),
});
export type FactionSummary = z.infer<typeof FactionSummary>;

/** Parsed landing page: site version + the list of faction subpages. */
export const SiteIndex = z.object({
  version: z.string().min(1),
  factions: z.array(FactionSummary).min(1),
});
export type SiteIndex = z.infer<typeof SiteIndex>;
