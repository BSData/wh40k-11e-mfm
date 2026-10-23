import type { CheerioAPI } from 'cheerio';
import { DETACHMENT_BOILERPLATE, PAGE_BOILERPLATE, UNIT_BOILERPLATE } from '../allowlists.js';
import { CARD_SELECTOR, cardName, isUnitCard, topCards } from './page.js';
import { findPanel, RULES_PANELS } from './panels.js';
import { clean } from './text.js';

/** The army-group title (`parent`), distinct from the UNITS/DETACHMENTS section headings. */
const PARENT_TITLE_SELECTOR = 'h3.font-header:not([class*="break-after"])';

/**
 * What is left of `text` once the `consumed` strings are subtracted — one occurrence
 * each, as each stands for one element a parse step read — and then every occurrence
 * of each `boilerplate` string, longest first within each. Used by the coverage
 * check: if a card's whole text minus everything the parser read is empty, the
 * parser consumed all of it.
 */
function residue(
  text: string,
  consumed: Iterable<string>,
  boilerplate: Iterable<string> = [],
): string {
  const longestFirst = (xs: Iterable<string>) =>
    [...xs].filter(Boolean).sort((a, b) => b.length - a.length);
  let rest = clean(text);
  for (const c of longestFirst(consumed)) rest = rest.replace(c, ' ');
  for (const b of longestFirst(boilerplate)) rest = rest.split(b).join(' ');
  return clean(rest);
}

/**
 * Completeness guard. The parser is a *pull* parser — it reads specific selectors
 * and ignores everything else — so a new section, field, badge, or row that Games
 * Workshop adds would otherwise be dropped with no error and no diff. This pass
 * inverts that: for every unit and detachment card it subtracts the strings the
 * card's parse step consumed (`consumed`, keyed by card element) plus the card
 * allowlist, then does the same for the page chrome, and throws if anything visible
 * is left over. New content fails loudly and locatedly instead of vanishing. Mutates
 * `$` (page-level pass strips parsed cards), so it must run last, after
 * units/detachments are built.
 */
export function assertFactionCovered(
  $: CheerioAPI,
  slug: string,
  name: string,
  version: string,
  consumed: ReadonlyMap<unknown, readonly string[]>,
): void {
  const leftovers: string[] = [];

  topCards($).each((_i, el) => {
    const card = $(el);
    const kind = isUnitCard($, card) ? 'unit' : 'detachment';
    const boilerplate = kind === 'unit' ? UNIT_BOILERPLATE : DETACHMENT_BOILERPLATE;
    const left = residue(card.text(), consumed.get(el) ?? [], boilerplate);
    if (left) leftovers.push(`${kind} "${cardName(card)}": ${JSON.stringify(left)}`);
  });

  // (c) Page level: drop the parsed cards, the site chrome (header/nav/footer, the cookie
  // dialog present on browser renders, the open rules panels captured into
  // meta.notes/meta.muster), then assert only known content-area headings (plus the faction
  // name, sub-group/parent-army titles and version) remain. Catches a brand-new
  // top-level section that sits outside any card.
  $(CARD_SELECTOR).remove();
  $('header, nav, footer, [id^="onetrust"], .onetrust-pc-dark-filter').remove();
  $('script, style, noscript, svg, head, link').remove();
  // The rules panels (open only) are captured into meta.yaml, not faction data.
  for (const label of Object.values(RULES_PANELS)) findPanel($, label)?.remove();
  const pageLeft = residue(
    $('body').text(),
    [],
    [
      ...PAGE_BOILERPLATE,
      name,
      name.toUpperCase(),
      `v${version}`,
      // Sub-group / parent-army titles, each claimed on its own (a page can carry more
      // than one, e.g. Aeldari's "Harlequins" and "Ynnari").
      ...$(PARENT_TITLE_SELECTOR)
        .map((_j, el) => clean($(el).text()))
        .get(),
    ],
  );
  if (pageLeft) leftovers.push(`page-level: ${JSON.stringify(pageLeft)}`);

  if (leftovers.length > 0) {
    throw new Error(
      `Unconsumed content on "${slug}": the page has data no selector captured. ` +
        'Handle it in src/parse/ (and specs/scraping.md), or add it to the relevant ' +
        `boilerplate allowlist if it is chrome:\n  ${leftovers.join('\n  ')}`,
    );
  }
}
