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

/** Strips the literal "UNIQUE:" prefix off a detachment restriction banner. */
const UNIQUE_RE = /^\s*unique:\s*/i;

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

function parseCostRow(unitName: string, raw: string): CostOption {
  // Belt-and-braces: strip any `▲`/`▼ (±N)` change marker that survived `deannotate`
  // so a delta can never be miscounted as a model or leak into `desc`.
  const text = clean(raw.replace(DELTA_MARKER_RE, ''));
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
function parseRole(card: ReturnType<CheerioAPI>): Pick<Unit, 'role' | 'attachTo'> {
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
      const points = leadingInt(clean(spans.last().text()).replace(DELTA_MARKER_RE, ''));
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

/**
 * Every unit and detachment renders as one of these card containers; the parser
 * walks these rather than the name element, so a card is handled whole and in
 * isolation regardless of whether its header is in the plain or "changed" style.
 */
const CARD_SELECTOR = 'div.flex.flex-col.space-y-1.m-1';

/**
 * The "changed since the last MFM" annotation layer. After a points update GW
 * decorates the affected cards with change chrome: a red/emerald/amber header, a
 * `▲`/`▼` direction glyph on the name and each moved cost, a `(±N)` delta beside
 * the new points, and a trailing `UPDATED` badge (optionally with a note). None of
 * it is data — the current points are the `NN pts` value and the change history is
 * the git diff of `data/` — and it disappears at the next update, so we strip it
 * back to the plain shape before parsing. A note string we do *not* recognise is
 * left in place so the coverage check surfaces it rather than silently dropping it.
 */
const DELTA_MARKER_RE = /[▲▼]\s*(?:\([+-]\d+\)\s*)?/g;
const CHANGE_BADGE_TEXT: readonly string[] = [
  'UPDATED',
  'FORCE DISPOSITION(S) CHANGED',
  'REQUISITION THRESHOLDS REMOVED',
  'UNIQUE TAG REMOVED',
];

function deannotate($: CheerioAPI): void {
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
function cardName(card: ReturnType<CheerioAPI>): string {
  const header = card.children().first();
  const span = header.find('span.text-xl').first();
  return clean(span.length > 0 ? span.text() : header.text());
}

/**
 * A card prices a unit iff it carries a "YOUR … COST(S)" tier label; detachment
 * cards never do (their labels are `ENHANCEMENTS`, a `UNIQUE:` banner or an
 * objective). This holds in both header styles and with the annotation layer off.
 */
function isUnitCard($: CheerioAPI, card: ReturnType<CheerioAPI>): boolean {
  return card.find('div.bg-slate-200').filter((_, el) => /COST/i.test($(el).text())).length > 0;
}

/** Top-level cards only (a card is never nested in another, but guard regardless). */
function topCards($: CheerioAPI): ReturnType<CheerioAPI> {
  return $(CARD_SELECTOR).filter((_, el) => $(el).parents(CARD_SELECTOR).length === 0);
}

function parseUnit($: CheerioAPI, card: ReturnType<CheerioAPI>): Unit {
  const name = titleCase(cardName(card));
  const pricing: PricingTier[] = [];

  // Each tier = a `div.bg-slate-200` label followed by a `ul.leaders` of rows. The
  // role block's `div.bg-slate-200` label (LEADER/SUPPORT) has no `ul.leaders`, so
  // it contributes no costs and is skipped.
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
    ...parseRole(card),
    ...(wargear.length > 0 ? { wargear } : {}),
  };
}

/** Units a detachment enhancement grants an ability to via a "LEADER:"/"SUPPORT:" block. */
function enhancementGrant(
  $: CheerioAPI,
  li: ReturnType<CheerioAPI>,
  keyword: 'LEADER:' | 'SUPPORT:',
): string[] {
  return clean(
    li
      .parent()
      .find('span')
      .filter((_j, s) => clean($(s).text()) === keyword)
      .first()
      .nextAll('span')
      .first()
      .text(),
  )
    .split(',')
    .map((s) => titleCase(s))
    .filter(Boolean);
}

function parseDetachment($: CheerioAPI, card: ReturnType<CheerioAPI>): Detachment {
  const header = card.children().first();
  const name = titleCase(cardName(card));
  const dp = leadingInt(clean(header.find('span.self-end').last().text()));
  // Objective is the styled banner div directly under the header.
  const objText = clean(card.children('div[style]').first().text());
  // "UNIQUE: X" restriction banner — a direct-child slate-200 div (same class units
  // use for tier labels, here repurposed). Match on the literal prefix so the change
  // badge/note divs (also direct children) are never mistaken for it.
  const unique = titleCase(
    clean(
      card
        .children('div.bg-slate-200')
        .filter((_j, el) => UNIQUE_RE.test(clean($(el).text())))
        .first()
        .text(),
    ).replace(UNIQUE_RE, ''),
  );
  const enhancements = card
    .find('ul.leaders li')
    .map((_i, el) => {
      const li = $(el);
      const spans = li.find('div').last().find('span');
      const enhName = clean(spans.first().text());
      const points = leadingInt(clean(spans.last().text()));
      if (!enhName || points === null) return null;
      // A "LEADER:"/"SUPPORT:" block sits beside the enhancement it belongs to (a
      // sibling of the <li> in the same wrapper): buying it unlocks those units.
      const leaderTo = enhancementGrant($, li, 'LEADER:');
      const supportTo = enhancementGrant($, li, 'SUPPORT:');
      return {
        name: enhName,
        points,
        ...(leaderTo.length > 0 ? { leaderTo } : {}),
        ...(supportTo.length > 0 ? { supportTo } : {}),
      };
    })
    .get()
    .filter((e): e is NonNullable<typeof e> => e !== null);

  return { name, dp, objective: objText || null, ...(unique ? { unique } : {}), enhancements };
}

/**
 * Boilerplate the parser deliberately does not turn into data. These are the
 * *only* strings allowed to go unconsumed; anything else surfacing in the
 * coverage pass is treated as new content and fails the parse. Keep each list
 * tight — a too-broad entry here is how a real addition gets silently swallowed.
 */
const UNIT_BOILERPLATE: readonly string[] = [];
const DETACHMENT_BOILERPLATE: readonly string[] = ['ENHANCEMENTS'];
// Page chrome is mostly removed by container (header/nav/cookie dialog/notes) in
// the page-level pass; these are the few content-area headings that remain.
const PAGE_BOILERPLATE: readonly string[] = [
  'Welcome to the Munitorum Field Manual, containing the most up-to-date points values for every Warhammer 40,000 faction.',
  'Show Legends', // the Legends toggle label (sits in the content area, not the nav)
  'Hide Legends', // its toggled state, on browser (Legends) renders
  'UNITS',
  'DETACHMENTS',
  'LEGENDS', // section heading shown on browser renders with Legends toggled on
];
/** Anchor identifying the expandable "Welcome…" notes block (captured into meta.notes). */
const NOTES_ANCHOR = 'To muster a Warhammer 40,000 army';

/**
 * The "Welcome…" notes block: the tightest element carrying the anchor, and among
 * equal-length ties the innermost (deepest) one — a thin wrapper and its real
 * content div have identical text, so prefer the content. `null` if not present.
 */
function findNotesBlock($: CheerioAPI): ReturnType<CheerioAPI> | null {
  const el = $('div, section')
    .filter((_i, e) => $(e).text().includes(NOTES_ANCHOR))
    .toArray()
    .sort(
      (a, b) =>
        $(a).text().length - $(b).text().length || $(b).parents().length - $(a).parents().length,
    )[0];
  return el ? $(el) : null;
}
/** The army-group title (`parent`), distinct from the UNITS/DETACHMENTS section headings. */
const PARENT_TITLE_SELECTOR = 'h3.font-header:not([class*="break-after"])';

/**
 * Subtract every `claimed` fragment from `text` (longest first, all occurrences)
 * and return what is left. Used by the coverage check: if a card's whole text
 * minus everything the parser read is empty, the parser consumed all of it.
 */
function residue(text: string, claimed: Iterable<string>): string {
  let rest = clean(text);
  for (const c of [...claimed].filter(Boolean).sort((a, b) => b.length - a.length)) {
    rest = rest.split(c).join(' ');
  }
  return clean(rest);
}

/**
 * Completeness guard. The parser is a *pull* parser — it reads specific selectors
 * and ignores everything else — so a new section, field, badge, or row that Games
 * Workshop adds would otherwise be dropped with no error and no diff. This pass
 * inverts that: it re-reads every unit card, every detachment card, and the page
 * chrome, subtracts everything the parser claimed, and throws if anything visible
 * is left over (beyond the explicit boilerplate allowlists above). New content
 * fails loudly and locatedly instead of vanishing. Mutates `$` (page-level pass
 * strips parsed cards), so it must run last, after units/detachments are built.
 */
function assertFactionCovered($: CheerioAPI, slug: string, name: string, version: string): void {
  const leftovers: string[] = [];

  topCards($).each((_i, el) => {
    const card = $(el);
    if (isUnitCard($, card)) {
      // (a) Unit card: name + every pricing tier (label + rows) + role + wargear
      // must account for the entire card.
      const claimed = [...UNIT_BOILERPLATE, cardName(card)];
      card.find('div.bg-slate-200').each((_j, l) => {
        claimed.push(clean($(l).text()));
        $(l)
          .nextAll('ul.leaders')
          .first()
          .find('li')
          .each((_k, li) => {
            claimed.push(clean($(li).text()));
          });
      });
      const img = card.find('img[src$="leader.svg"], img[src$="support.svg"]').first();
      if (img.length) claimed.push(clean(img.parent().nextAll('span').first().text()));
      const cog = card.find('img[src$="cog.svg"]').first();
      if (cog.length)
        cog
          .parent()
          .parent()
          .find('ul li')
          .each((_j, li) => {
            claimed.push(clean($(li).text()));
          });
      const left = residue(card.text(), claimed);
      if (left) leftovers.push(`unit "${cardName(card)}": ${JSON.stringify(left)}`);
    } else {
      // (b) Detachment card: name + DP + objective + unique + leaderTo/supportTo
      // grants + enhancements.
      const header = card.children().first();
      const claimed = [
        ...DETACHMENT_BOILERPLATE,
        cardName(card),
        clean(header.find('span.self-end').last().text()),
        clean(card.children('div[style]').first().text()),
        ...card
          .children('div.bg-slate-200')
          .map((_j, l) => clean($(l).text()))
          .get(),
      ];
      for (const kw of ['LEADER:', 'SUPPORT:'] as const) {
        card
          .find('span')
          .filter((_j, s) => clean($(s).text()) === kw)
          .each((_j, s) => {
            claimed.push(kw, clean($(s).nextAll('span').first().text()));
          });
      }
      card.find('ul.leaders li').each((_j, li) => {
        const spans = $(li).find('div').last().find('span');
        claimed.push(clean(spans.first().text()), clean(spans.last().text()));
      });
      const left = residue(card.text(), claimed);
      if (left) leftovers.push(`detachment "${cardName(card)}": ${JSON.stringify(left)}`);
    }
  });

  // (c) Page level: drop the parsed cards, the site chrome (header/nav, the cookie
  // dialog present on browser renders, the "Welcome…" notes captured into
  // meta.notes), then assert only known content-area headings (plus the faction
  // name, sub-group/parent-army titles and version) remain. Catches a brand-new
  // top-level section that sits outside any card.
  $(CARD_SELECTOR).remove();
  $('header, nav, [id^="onetrust"], .onetrust-pc-dark-filter').remove();
  $('script, style, noscript, svg, head, link').remove();
  // The notes block (expanded only) is captured into meta.notes, not faction data.
  findNotesBlock($)?.remove();
  const pageLeft = residue($('body').text(), [
    ...PAGE_BOILERPLATE,
    name,
    name.toUpperCase(),
    `v${version}`,
    // Sub-group / parent-army titles, each claimed on its own (a page can carry more
    // than one, e.g. Aeldari's "Harlequins" and "Ynnari").
    ...$(PARENT_TITLE_SELECTOR)
      .map((_j, el) => clean($(el).text()))
      .get(),
  ]);
  if (pageLeft) leftovers.push(`page-level: ${JSON.stringify(pageLeft)}`);

  if (leftovers.length > 0) {
    throw new Error(
      `Unconsumed content on "${slug}": the page has data no selector captured. ` +
        'Handle it in src/parse.ts (and specs/scraping.md), or add it to the relevant ' +
        `boilerplate allowlist if it is chrome:\n  ${leftovers.join('\n  ')}`,
    );
  }
}

/**
 * Parse a faction subpage. `name`/`slug` come from the index (clean display name).
 * `knownFactions` is the set of all faction display names (lower-cased) used to tell a
 * genuine parent-army title from a same-shaped sub-army/army-rule heading.
 */
export function parseFaction(
  html: string,
  slug: string,
  name: string,
  knownFactions: ReadonlySet<string> = new Set(),
): FactionContent {
  const $ = load(html);
  const version = parseVersion($);
  hydrate($);
  deannotate($);

  // Units are partitioned into a base roster (directly under the UNITS section) plus
  // named sub-groups introduced by army-group headers — `h3.font-header` *without* the
  // section break-after class — e.g. "Harlequins"/"Ynnari" on Aeldari, a Chapter on
  // Space Marines, the shared "Space Marines" roster on a successor chapter. Walk the
  // headers and cards in document order so each unit picks up the sub-group it sits
  // under; a section header (UNITS/DETACHMENTS) resets back to the base roster.
  const groupTitles: string[] = [];
  const groupByCard = new Map<unknown, string | undefined>();
  let currentGroup: string | undefined;
  $(`h3.font-header, ${CARD_SELECTOR}`).each((_i, el) => {
    if ((el as { tagName?: string }).tagName === 'h3') {
      const isSection = ($(el).attr('class') ?? '').includes('break-after');
      currentGroup = isSection ? undefined : titleCase($(el).text());
      if (currentGroup) groupTitles.push(currentGroup);
    } else if (isUnitCard($, $(el))) {
      groupByCard.set(el, currentGroup);
    }
  });

  // Each card is a unit or a detachment; parse it whole, in document order.
  const units: Unit[] = [];
  const detachments: Detachment[] = [];
  topCards($).each((_i, el) => {
    const card = $(el);
    if (isUnitCard($, card)) {
      const unit = parseUnit($, card);
      const group = groupByCard.get(el);
      units.push(group ? { ...unit, groupTitle: group } : unit);
    } else {
      detachments.push(parseDetachment($, card));
    }
  });
  if (units.length === 0) {
    throw new Error(`No units found for "${slug}" — the card/name selector may have drifted`);
  }

  // A sub-group header that names *another* known faction marks this as that faction's
  // successor (e.g. "Space Marines" for Black Templars). Surfaced at the faction level as
  // `parent`; the units in that group also carry it as their `groupTitle`. Non-faction
  // sub-group headers (e.g. "Harlequins") live only on the units, not here.
  const parent = groupTitles.find(
    (t) => t.toLowerCase() !== name.toLowerCase() && knownFactions.has(t.toLowerCase()),
  );

  // Last: prove we left nothing on the page unread (mutates $).
  assertFactionCovered($, slug, name, version);

  return { slug, name, version, ...(parent ? { parent } : {}), detachments, units };
}

/** All-caps standalone label (e.g. "UNITS") promoted to a Markdown heading. */
const NOTES_HEADING_RE = /^[A-Z][A-Z0-9 ()/'’-]+$/;

/**
 * Convert the rendered "Welcome…" notes block to Markdown, keeping its structure:
 * `<b>` → `**bold**`, all-caps standalone labels → `## headings`, `<ul>/<li>` →
 * bullet lists, `<br><br>` → paragraph breaks. `pageHtml` is a fully-rendered
 * page's HTML (from the browser, where the notes are expanded); returns `''` if
 * the notes block isn't present. Pure — used by `browser.ts`'s `extractNotes`.
 */
export function extractNotesMarkdown(pageHtml: string): string {
  const $ = load(pageHtml);
  const block = findNotesBlock($);
  if (!block) return '';

  // Inline run → Markdown (bold, soft breaks); used for list items and paragraphs.
  const inline = (el: ReturnType<CheerioAPI>): string => {
    let s = '';
    el.contents().each((_i, n) => {
      if (n.type === 'text') {
        s += $(n).text();
      } else if (n.type === 'tag') {
        if (n.tagName === 'b' || n.tagName === 'strong') {
          const t = clean($(n).text());
          if (t) s += `**${t}**`;
        } else if (n.tagName === 'br') {
          s += '\n';
        } else {
          s += inline($(n));
        }
      }
    });
    return s;
  };

  let md = '';
  block.contents().each((_i, n) => {
    if (n.type === 'text') {
      md += $(n).text();
    } else if (n.type === 'tag') {
      if (n.tagName === 'ul' || n.tagName === 'ol') {
        md += '\n';
        $(n)
          .children('li')
          .each((_j, li) => {
            md += `\n- ${clean(inline($(li)))}`;
          });
        md += '\n\n';
      } else if (n.tagName === 'b' || n.tagName === 'strong') {
        const t = clean($(n).text());
        if (NOTES_HEADING_RE.test(t)) md += `\n\n## ${t}\n\n`;
        else if (t) md += `**${t}**`;
      } else if (n.tagName === 'br') {
        md += '\n';
      } else {
        md += inline($(n));
      }
    }
  });

  return md
    .replace(/\r/g, '')
    .replace(/[^\S\n]+/g, ' ') // collapse runs of spaces/tabs, keep newlines
    .replace(/ *\n */g, '\n') // trim spaces around line breaks
    .replace(/\n{3,}/g, '\n\n') // at most one blank line between blocks
    .trim();
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
