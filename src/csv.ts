import { factionDocument } from './emit.js';
import type { Faction } from './model.js';

/**
 * `data/points.csv`: every unit's points as one flat table, for spreadsheets (see "Points
 * table" in specs/data-model.md). One row per faction, unit, tier and cost option. The
 * rows follow the faction files: factions by slug, units in the files' name order, then
 * each unit's tiers and cost options in source order. Points never decide a row's place,
 * so a points change is a one-line diff. Pure: factions in, text out.
 */

/** Its name in `data/`. */
export const POINTS_CSV = 'points.csv';

/** The columns, named after the fields they hold. */
export const POINTS_COLUMNS = [
  'faction',
  'unit',
  'groupTitle',
  'legends',
  'range',
  'label',
  'models',
  'points',
  'desc',
  'addon',
] as const;

/** A field as RFC 4180 has it: quoted when it holds a comma, a quote or a line break. */
const field = (value: string | number | undefined): string => {
  const text = value === undefined ? '' : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

/** `points.csv` for these factions: a header line, then one line per cost option. */
export function pointsCsv(factions: Faction[]): string {
  const lines = [POINTS_COLUMNS.join(',')];
  // Slugs in code-unit order, as `meta.yaml` lists them and a directory listing shows them.
  const bySlug = [...factions].sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  for (const f of bySlug) {
    for (const u of factionDocument(f).units) {
      for (const t of u.pricing) {
        for (const c of t.costs) {
          const row = [
            f.slug,
            u.name,
            u.groupTitle,
            u.legends ? 'true' : undefined,
            t.range,
            t.label,
            c.models,
            c.points,
            c.desc,
            c.addon ? 'true' : undefined,
          ];
          lines.push(row.map(field).join(','));
        }
      }
    }
  }
  return `${lines.join('\n')}\n`;
}
