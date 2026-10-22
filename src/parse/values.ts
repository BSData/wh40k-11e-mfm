import type { CheerioAPI } from 'cheerio';
import type { CostOption } from '../model.js';
import { DELTA_MARKER_RE } from './page.js';
import { clean } from './text.js';

/** The values on a page: points, DP, the site version, tier ranges and cost rows. */

const VERSION_RE = /v(\d+\.\d+)/;

/** A whole points value: "NN pts", where commas are thousands separators. */
const POINTS_RE = /^(\d{1,3}(?:,\d{3})+|\d+)\s*pts$/i;

/**
 * The one parser for points, wherever they appear (cost rows, wargear, enhancements):
 * "65 pts" → 65, "2,200 pts" → 2200. Anything else ("FREE", a leftover delta) is null.
 */
export function parsePoints(s: string): number | null {
  const m = clean(s).match(POINTS_RE);
  return m ? Number.parseInt((m[1] as string).replace(/,/g, ''), 10) : null;
}

/** A detachment's DP badge, the whole of it ("2DP"). */
export const DP_RE = /^(\d+)\s*DP$/i;

const ORDINAL_RE = /(\d+)(?:st|nd|rd|th)/gi;

/** Strips the literal "UNIQUE:" prefix off a detachment restriction banner. */
export const UNIQUE_RE = /^\s*unique:\s*/i;

/**
 * Parse a tier label into the interval of unit copies it prices, in mathematical
 * notation. `[a,b]` is closed; `[a,)` is unbounded ("and beyond").
 *   "Your Unit Costs"           → "[1,)"
 *   "Your 1st Unit Costs"       → "[1,1]"
 *   "Your 2nd + Unit Costs"     → "[2,)"
 *   "Your 1st To 2nd Units Cost"→ "[1,2]"
 */
export function parseRange(label: string): string {
  const ords = [...label.matchAll(ORDINAL_RE)].map((m) => Number.parseInt(m[1] as string, 10));
  if (ords.length === 0) return '[1,)';
  const from = ords[0] as number;
  if (/\bto\b/i.test(label) && ords.length >= 2) return `[${from},${ords[1]}]`;
  if (label.includes('+')) return `[${from},)`;
  return `[${from},${from}]`;
}

// Points are the trailing "NN pts" (located here, read by `parsePoints`); everything
// before is the size text, which the two parts concatenate onto without a separator
// ("1 model2,200 pts").
const TRAILING_POINTS_RE = /[\d,]+\s*pts\s*$/i;
const PLAIN_SIZE_RE = /^\d+ models?$/i;
/**
 * What a size never contains but a change delta does: a bracket, a glyph, a minus before
 * a number, or a plus before a number anywhere but the start (where it marks an add-on,
 * "+ 1 Invader ATV"). A delta `DELTA_MARKER_RE` doesn't recognise leaves these behind,
 * and its digits would otherwise be summed into `models`.
 */
const DELTA_LEFTOVER_RE = /[()▲▼]|[-−–]\s*\d|\S\s*\+\s*\d/;

/** One cost row. `where` locates the card for the error (see `cardWhere`). */
export function parseCostRow(where: string, raw: string): CostOption {
  // Belt-and-braces: strip any `▲`/`▼ (±N)` change marker that survived `deannotate`
  // so a delta can never be miscounted as a model or leak into `desc`.
  const text = clean(raw.replace(DELTA_MARKER_RE, ''));
  const m = text.match(TRAILING_POINTS_RE);
  const size = m ? clean(text.slice(0, m.index)) : '';
  const points = m ? parsePoints(m[0]) : null;
  if (points === null || !size || DELTA_LEFTOVER_RE.test(size)) {
    throw new Error(`${where}: unreadable cost row "${text}"`);
  }
  const models = (size.match(/\d+/g) ?? []).reduce((sum, n) => sum + Number.parseInt(n, 10), 0);

  if (size.startsWith('+')) {
    // "+ 1 Invader ATV" → add-on; keep just the item name as desc.
    const item = clean(size.replace(/^\+\s*\d*\s*/, ''));
    return item ? { models, points, desc: item, addon: true } : { models, points, addon: true };
  }
  // Keep a desc only when the row isn't a plain "N models" (named/composite),
  // so simple rows stay terse and ambiguous ones (same model count) disambiguate.
  return PLAIN_SIZE_RE.test(size) ? { models, points } : { models, points, desc: size };
}

export function parseVersion($: CheerioAPI): string {
  const m = $('body').text().match(VERSION_RE);
  if (!m) throw new Error('Could not find a version stamp (vX.Y) on the page');
  return m[1] as string;
}
