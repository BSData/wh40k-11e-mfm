/**
 * The strings the coverage check in `src/parse/coverage.ts` accepts without turning them
 * into data: the labels over the blocks a parse step reads, and the site chrome and
 * annotation it deliberately ignores. Anything else left over on a page is treated as new
 * content and fails the parse. They live on their own so code owners can guard them: each
 * entry is a decision that some text on the site is not data, made in a reviewed commit.
 * Keep each list tight — a too-broad entry here is how a real addition gets silently
 * swallowed. See "Completeness coverage" in specs/scraping.md.
 */

/**
 * Unit-card block labels, by the field the block fills; the icon beside each, not the
 * label, identifies the block. Each is consumed once, by the step that reads its block and
 * only when that step read something from it; they are not subtracted wholesale, so a
 * second copy, a label with no list after it, or a renamed one is left over.
 */
export const UNIT_BLOCK_LABELS = {
  leaderTo: 'LEADER',
  supportTo: 'SUPPORT',
  wargear: 'WARGEAR OPTIONS',
} as const;

/**
 * The heading over a detachment's enhancements list, consumed once with the list it heads,
 * as the unit-card block labels are, not subtracted wholesale.
 */
export const ENHANCEMENTS_LABEL = 'ENHANCEMENTS';

// Page chrome is mostly removed by container (header/nav/footer/cookie dialog/rules panels)
// in the page-level pass; these are the few content-area headings that remain. Subtracted
// wholesale, every occurrence: the page level has no blocks to tie them to.
export const PAGE_BOILERPLATE: readonly string[] = [
  // The rules panels' button labels (`RULES_PANELS` in src/parse/panels.ts) — always shown,
  // open or not.
  'Welcome to the Munitorum Field Manual, containing the most up-to-date points values for every Warhammer 40,000 faction.',
  'Muster Armies',
  'Show Legends', // the Legends toggle label (sits in the content area, not the nav)
  'Hide Legends', // its toggled state, on browser (Legends) renders
  'UNITS',
  'DETACHMENTS',
  'LEGENDS', // section heading over the Legends, when shown (the Legends cookie, or the toggle)
];

/**
 * The "changed since the last MFM" badge and the notes that may follow it, each a small
 * div of its own on a changed unit or detachment card. `deannotate()` removes divs whose
 * whole text is one of these; a note not listed here is left in place and fails the
 * coverage check.
 */
export const CHANGE_BADGE_TEXT: readonly string[] = [
  'UPDATED',
  'FORCE DISPOSITION(S) CHANGED',
  'REQUISITION THRESHOLDS REMOVED',
  'UNIQUE TAG REMOVED',
  // v1.6, on units whose Leader/Support list changed (test/fixtures/space-marines.html).
  'BODYGUARD UNITS UPDATED',
  // v1.6, on units whose wargear costs were dropped (test/fixtures/adeptus-custodes.html).
  'WARGEAR COSTS REMOVED',
];
