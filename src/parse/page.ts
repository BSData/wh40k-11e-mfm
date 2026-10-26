import type { CheerioAPI } from 'cheerio';
import { CHANGE_BADGE_TEXT } from '../allowlists.js';
import { clean } from './text.js';

/**
 * The page as the parser sees it: the streamed chunks put back together, the "changed
 * since the last MFM" layer stripped, and the content cut into unit and detachment cards.
 */

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
export function hydrate($: CheerioAPI): void {
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

/**
 * Every unit and detachment renders as one of these card containers; the parser
 * walks these rather than the name element, so a card is handled whole and in
 * isolation regardless of whether its header is in the plain or "changed" style.
 */
export const CARD_SELECTOR = 'div.flex.flex-col.space-y-1.m-1';

/**
 * A unit card's pricing-tier label: a `TIER_LABEL_SELECTOR` element whose whole text reads
 * "YOUR … COST(S)" (`TIER_LABEL_RE`: "YOUR UNIT COSTS", "YOUR 1ST TO 2ND UNITS COST",
 * "YOUR 4TH + UNIT COSTS"), followed by its `ul.leaders` (see `tierLabels`). Anchored,
 * because a change note is a `TIER_LABEL_SELECTOR` element too and may mention costs
 * ("ENHANCEMENT COSTS CHANGED"). Detachment cards have no tier label.
 */
export const TIER_LABEL_SELECTOR = 'div.bg-slate-200';
export const TIER_LABEL_RE = /^\s*YOUR\b.*\bCOSTS?\s*$/i;

/**
 * The "changed since the last MFM" annotation layer. After a points update GW
 * decorates the affected cards with change chrome: a red/emerald/amber header, a
 * `▲`/`▼` direction glyph on the name and each moved cost, a `(±N)` delta beside
 * the new points, and a trailing `UPDATED` badge (optionally with a note). None of
 * it is data — the current points are the `NN pts` value and the change history is
 * the git diff of `data/` — and it disappears at the next update, so we strip it
 * back to the plain shape before parsing. A note string we do *not* recognise (see
 * `CHANGE_BADGE_TEXT` in src/allowlists.ts) is left in place so the coverage check
 * surfaces it rather than silently dropping it. The delta is written like points, so
 * it may carry thousands separators, and its minus may be `−` (U+2212).
 */
export const DELTA_MARKER_RE = /[▲▼]\s*(?:\([-+−]\d[\d,]*\)\s*)?/g;

export function deannotate($: CheerioAPI): void {
  // Drop the standalone `UPDATED` / note badge divs (each a small div of one span).
  $('div').each((_, el) => {
    if (CHANGE_BADGE_TEXT.includes(clean($(el).text()))) $(el).remove();
  });
  // Strip the `▲`/`▼` glyphs and `(±N)` deltas from the leaf text spans that carry
  // them — the header direction badge and the coloured points cells.
  $('span').each((_, el) => {
    const span = $(el);
    if (span.children().length > 0) return;
    const text = span.text();
    if (/[▲▼]/.test(text)) span.text(clean(text.replace(DELTA_MARKER_RE, '')));
  });
}

/**
 * A card's display name. Plain unit headers put the name in the header div's own
 * text (`div.bg-slate-500.text-xl`); detachment headers and every "changed"-style
 * header put it in a `span.text-xl` inside a flex-row header.
 */
export function cardName(card: ReturnType<CheerioAPI>): string {
  const header = card.children().first();
  const span = header.find('span.text-xl').first();
  return clean(span.length > 0 ? span.text() : header.text());
}

/**
 * A card's pricing-tier labels: each a "YOUR … COST(S)" label immediately followed by its
 * `ul.leaders` of cost rows. The parser reads a tier from each of these and from nothing
 * else, so a note beside a label, inside the tier's wrapper, is left over for the coverage
 * check instead of being read as a tier of its own.
 */
export function tierLabels($: CheerioAPI, card: ReturnType<CheerioAPI>): ReturnType<CheerioAPI> {
  return card
    .find(TIER_LABEL_SELECTOR)
    .filter(
      (_, el) => TIER_LABEL_RE.test(clean($(el).text())) && $(el).next('ul.leaders').length > 0,
    );
}

/**
 * A card prices a unit iff it carries a tier label (`tierLabels`). Detachment cards never
 * do: their labels are `ENHANCEMENTS`, a `UNIQUE:` banner, an objective or a change note,
 * and a note has no list after it, whatever it reads. This holds in both header styles and
 * with the annotation layer off.
 */
export function isUnitCard($: CheerioAPI, card: ReturnType<CheerioAPI>): boolean {
  return tierLabels($, card).length > 0;
}

/** A card's location for error messages: `"necrons", unit "TECHNOMANCER"`. */
export function cardWhere(slug: string, kind: 'unit' | 'detachment', card: ReturnType<CheerioAPI>) {
  return `"${slug}", ${kind} "${cardName(card)}"`;
}

/** Top-level cards only (a card is never nested in another, but guard regardless). */
export function topCards($: CheerioAPI): ReturnType<CheerioAPI> {
  return $(CARD_SELECTOR).filter((_, el) => $(el).parents(CARD_SELECTOR).length === 0);
}
