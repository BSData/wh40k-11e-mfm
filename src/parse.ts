/**
 * HTML parsing for the Munitorum Field Manual. Pure functions: HTML string in,
 * domain objects out — no network or filesystem. See specs/scraping.md for the
 * selector contract and the React-streaming detail these functions rely on.
 *
 * Each card parser takes a `consumed` list and pushes onto it the exact text of every
 * element it turned into data, as it reads it. That list, not a second pass over the
 * selectors, is what the coverage check counts as covered, so anything a parse step
 * looks at but drops is left over and fails the parse.
 *
 * This file is the public API; the modules behind it, under `src/parse/`:
 *  - `page.ts` — the page put back together (`hydrate`), the change layer stripped
 *    (`deannotate`), and the cards;
 *  - `cards.ts` — a unit or detachment card, with `values.ts` (points, DP, ranges, cost
 *    rows), `names.ts` (`nameCase`, `titleCase`) and `text.ts`;
 *  - `coverage.ts` — the completeness check;
 *  - `panels.ts` — the rules panels as Markdown, with `rsc.ts` (the page's React Server
 *    Components payload, where a plain page carries them);
 *  - `faction.ts` — a faction page and the index, and the Legends.
 */

export { markLegends, type PageOptions, parseFaction, parseIndex } from './parse/faction.js';
export { nameCase, OFFICIAL_SPELLINGS } from './parse/names.js';
export {
  CARD_SELECTOR,
  TIER_LABEL_RE,
  TIER_LABEL_SELECTOR,
} from './parse/page.js';
export {
  extractMusterMarkdown,
  extractNotesMarkdown,
  RULES_PANELS,
  type RulesPanels,
  rulesPanels,
} from './parse/panels.js';
