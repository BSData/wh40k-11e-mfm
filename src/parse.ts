import { type CheerioAPI, load } from 'cheerio';
import type {
  CostOption,
  Detachment,
  FactionContent,
  PricingTier,
  SiteIndex,
  Unit,
  Wargear,
} from './model.js';

/**
 * HTML parsing for the Munitorum Field Manual. Pure functions: HTML string in,
 * domain objects out — no network or filesystem. See specs/scraping.md for the
 * selector contract and the React-streaming detail these functions rely on.
 */

const VERSION_RE = /v(\d+\.\d+)/;

/** Collapse whitespace and trim. */
function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Convert the site's ALL-CAPS labels to readable Title Case, deterministically. */
function titleCase(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/(^|[\s'’(-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/** Leading integer from strings like "10 models", "2DP". */
function leadingInt(s: string): number | null {
  const m = s.match(/-?\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

const ORDINAL_RE = /(\d+)(?:st|nd|rd|th)/gi;

/**
 * Parse a tier label into the interval of unit copies it prices, in mathematical
 * notation. `[a,b]` is closed; `[a,)` is unbounded ("and beyond").
 *   "Your Unit Costs"           → "[1,)"
 *   "Your 1st Unit Costs"       → "[1,1]"
 *   "Your 2nd + Unit Costs"     → "[2,)"
 *   "Your 1st To 2nd Units Cost"→ "[1,2]"
 */
function parseRange(label: string): string {
  const ords = [...label.matchAll(ORDINAL_RE)].map((m) => Number.parseInt(m[1] as string, 10));
  if (ords.length === 0) return '[1,)';
  const from = ords[0] as number;
  if (/\bto\b/i.test(label) && ords.length >= 2) return `[${from},${ords[1]}]`;
  if (label.includes('+')) return `[${from},)`;
  return `[${from},${from}]`;
}

// Points are the trailing "NN pts" (commas are thousands separators, e.g.
// "2,200 pts"); everything before is the size text, which the two parts
// concatenate onto without a separator (e.g. "1 model2,200 pts").
const TRAILING_POINTS_RE = /([\d,]+)\s*pts\s*$/i;
const PLAIN_SIZE_RE = /^\d+ models?$/i;

function parseCostRow(unitName: string, text: string): CostOption {
  const m = text.match(TRAILING_POINTS_RE);
  const size = m ? clean(text.slice(0, m.index)) : '';
  if (!m || !size) throw new Error(`Unit "${unitName}": unreadable cost row "${text}"`);
  const points = Number.parseInt((m[1] as string).replace(/,/g, ''), 10);
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

/** Parse a Leader/Support role block (icon + comma-separated attach list), if present. */
function parseRole($: CheerioAPI, card: ReturnType<CheerioAPI>): Pick<Unit, 'role' | 'attachTo'> {
  const imgs = card.find('img[src$="leader.svg"], img[src$="support.svg"]');
  if (imgs.length === 0) return {};
  if (imgs.length > 1) throw new Error('Unexpected multiple role blocks on one unit');
  const img = imgs.first();
  const role = (img.attr('src') ?? '').includes('leader') ? 'leader' : 'support';
  const attachTo = clean(img.parent().nextAll('span').first().text())
    .split(',')
    .map((s) => titleCase(s))
    .filter(Boolean);
  return attachTo.length > 0 ? { role, attachTo } : {};
}

/** Parse the "Wargear Options" block (cog icon + per-item costs), if present. */
function parseWargear($: CheerioAPI, card: ReturnType<CheerioAPI>): Wargear[] {
  const cog = card.find('img[src$="cog.svg"]').first();
  if (cog.length === 0) return [];
  return cog
    .parent()
    .parent()
    .find('ul li')
    .map((_i, li) => {
      const spans = $(li).find('span');
      const item = clean(spans.first().text()).replace(/^per\s+/i, '');
      const points = leadingInt(clean(spans.last().text()));
      return item && points !== null ? { item, points } : null;
    })
    .get()
    .filter((w): w is Wargear => w !== null);
}

function parseVersion($: CheerioAPI): string {
  const m = $('body').text().match(VERSION_RE);
  if (!m) throw new Error('Could not find a version stamp (vX.Y) on the page');
  return m[1] as string;
}

/**
 * The page assembles itself from streamed React Suspense chunks: a card's parts
 * (name, pricing block, even a single model-count or points value) start as
 * `<template id="P:N">`/`<template id="B:N">` placeholders, and the resolved
 * markup arrives in sibling `<div hidden id="S:N">` blocks. The browser stitches
 * them with `$RS("S:N","P:N")` — matched by the hex suffix after the colon.
 *
 * We replay those swaps statically: replace every `<template id>` with the inner
 * HTML of its matching `S:` completion, repeating until stable (completions can
 * nest), then drop the now-consumed hidden blocks. After this the DOM looks like
 * the fully-rendered page and the rest of the parser can read inline values.
 */
function hydrate($: CheerioAPI): void {
  const completions = new Map<string, ReturnType<CheerioAPI>>();
  $('div[hidden][id^="S:"]').each((_, el) => {
    completions.set(($(el).attr('id') as string).slice(2), $(el));
  });

  let changed = true;
  for (let guard = 0; changed && guard < 100; guard++) {
    changed = false;
    $('template[id]').each((_, el) => {
      const suffix = ($(el).attr('id') ?? '').split(':')[1];
      const src = suffix ? completions.get(suffix) : undefined;
      if (src) {
        $(el).replaceWith(src.html() ?? '');
        changed = true;
      }
    });
  }
  $('div[hidden][id^="S:"]').remove();
}

function parseUnit($: CheerioAPI, nameDiv: ReturnType<CheerioAPI>): Unit {
  const name = titleCase(nameDiv.text());
  const card = nameDiv.parent();
  const pricing: PricingTier[] = [];

  // Each tier = a `div.bg-slate-200` label followed by a `ul.leaders` of rows.
  card.find('div.bg-slate-200').each((_, labelEl) => {
    const label = titleCase($(labelEl).text());
    const ul = $(labelEl).nextAll('ul.leaders').first();
    const costs = ul
      .find('li')
      .map((_i, li) => parseCostRow(name, clean($(li).text())))
      .get();
    if (costs.length > 0) pricing.push({ range: parseRange(label), label, costs });
  });

  if (pricing.length === 0) throw new Error(`Unit "${name}" has no pricing tiers`);
  const wargear = parseWargear($, card);
  return {
    name,
    pricing,
    ...parseRole($, card),
    ...(wargear.length > 0 ? { wargear } : {}),
  };
}

function parseDetachment($: CheerioAPI, nameSpan: ReturnType<CheerioAPI>): Detachment {
  const name = titleCase(nameSpan.text());
  const header = nameSpan.parent();
  const card = header.parent();
  const dp = leadingInt(clean(header.find('span').last().text()));
  // Objective is the styled banner div directly under the header.
  const objText = clean(card.children('div[style]').first().text());
  const enhancements = card
    .find('ul.leaders li')
    .map((_i, li) => {
      const spans = $(li).find('div').last().find('span');
      const enhName = clean(spans.first().text());
      const points = leadingInt(clean(spans.last().text()));
      if (!enhName || points === null) return null;
      return { name: enhName, points };
    })
    .get()
    .filter((e): e is { name: string; points: number } => e !== null);

  return { name, dp, objective: objText || null, enhancements };
}

/** Parse a faction subpage. `name`/`slug` come from the index (clean display name). */
export function parseFaction(html: string, slug: string, name: string): FactionContent {
  const $ = load(html);
  const version = parseVersion($);
  hydrate($);

  const units = $('div.bg-slate-500.text-xl')
    .map((_i, el) => parseUnit($, $(el)))
    .get();
  if (units.length === 0) {
    throw new Error(`No units found for "${slug}" — the unit-name selector may have drifted`);
  }

  const detachments = $('span.text-xl.break-all')
    .map((_i, el) => parseDetachment($, $(el)))
    .get();

  return { slug, name, version, detachments, units };
}

/**
 * Mark units that appear only in the legends-on render (`full`) as legends.
 * `base` is the default render (no legends); both are parser output of the same
 * faction. Returns `full` with `legends: true` on the units `base` doesn't have.
 */
export function markLegends(base: FactionContent, full: FactionContent): FactionContent {
  const baseNames = new Set(base.units.map((u) => u.name));
  return {
    ...full,
    units: full.units.map((u) => (baseNames.has(u.name) ? u : { ...u, legends: true })),
  };
}

/** Parse the landing page into the site version and the list of faction subpages. */
export function parseIndex(html: string): SiteIndex {
  const $ = load(html);
  const version = parseVersion($);
  const seen = new Map<string, string>();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') ?? '';
    const m = href.match(/^\/en\/([a-z0-9-]+)$/);
    if (!m) return;
    const slug = m[1] as string;
    const text = clean($(el).text());
    if (text && !seen.has(slug)) seen.set(slug, text);
  });
  if (seen.size === 0) throw new Error('No faction links found on the index page');
  const factions = [...seen.entries()].map(([slug, name]) => ({ slug, name }));
  return { version, factions };
}
