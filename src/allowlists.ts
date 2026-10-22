/**
 * The strings the parser may leave unconsumed: site chrome and annotation it deliberately
 * does not turn into data. These are the *only* exceptions to the coverage check in
 * `src/parse.ts`; anything else left over on a page is treated as new content and fails
 * the parse. They live on their own so code owners can guard them: each entry is a
 * decision that some text on the site is not data, made in a reviewed commit. Keep each
 * list tight — a too-broad entry here is how a real addition gets silently swallowed.
 * See "Completeness coverage" in specs/scraping.md.
 */

/** Unit-card block labels; the icon beside each, not the label, identifies the block. */
export const UNIT_BOILERPLATE: readonly string[] = ['LEADER', 'SUPPORT', 'WARGEAR OPTIONS'];

/** The heading over a detachment's enhancements list. */
export const DETACHMENT_BOILERPLATE: readonly string[] = ['ENHANCEMENTS'];

// Page chrome is mostly removed by container (header/nav/footer/cookie dialog/rules panels)
// in the page-level pass; these are the few content-area headings that remain.
export const PAGE_BOILERPLATE: readonly string[] = [
  // The rules panels' button labels (`RULES_PANELS` in src/parse.ts) — always shown,
  // open or not.
  'Welcome to the Munitorum Field Manual, containing the most up-to-date points values for every Warhammer 40,000 faction.',
  'Muster Armies',
  'Show Legends', // the Legends toggle label (sits in the content area, not the nav)
  'Hide Legends', // its toggled state, on browser (Legends) renders
  'UNITS',
  'DETACHMENTS',
  'LEGENDS', // section heading shown on browser renders with Legends toggled on
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
];
