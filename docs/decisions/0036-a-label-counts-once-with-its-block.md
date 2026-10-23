# 0036. A block label counts once, with the block it heads

- **Status:** accepted, for [#89](https://github.com/BSData/wh40k-11e-mfm/issues/89); revises [0019](0019-account-for-every-visible-string.md)
- **Spec:** [scraping — Completeness coverage](../../specs/scraping.md#completeness-coverage-dont-silently-drop-new-content), [Selectors](../../specs/scraping.md#selectors-the-drift-prone-surface)

## Context
[0019](0019-account-for-every-visible-string.md) covers a card's text with the strings its
parse step consumed, plus an allowlist per card kind: `LEADER`, `SUPPORT` and `WARGEAR
OPTIONS` on a unit, `ENHANCEMENTS` on a detachment. The allowlist was subtracted as global
substrings, every occurrence, whether or not the card had that block. The review of
[#85](https://github.com/BSData/wh40k-11e-mfm/pull/85) found what that lets through:
- a change note `SUPPORT` or `WARGEAR OPTIONS` on a unit, or `ENHANCEMENTS` on a
  detachment, passed silently;
- a role block GW emptied (the label with no list after it) passed silently too;
- a note `LEADER UPDATED` was reported as `"UPDATED"`, half of what the page shows.

The same review found a misclassification. A card was a unit if any `div.bg-slate-200` in it
matched `/COST/`. Change notes are `div.bg-slate-200` too, so a note `ENHANCEMENT COSTS
CHANGED` on a detachment made it a unit, and the parse failed on the wrong thing:
`unit "SANCTIFIED ORATORS": unreadable cost row "Hagiomnifex (Upgrade)25 pts"`.

## Decision
A block's label is consumed by the parse step that reads the block, once, and only when
that step read something from it (a non-empty list, a wargear row, an enhancement) and the
label reads exactly as listed in `src/allowlists.ts` (`UNIT_BLOCK_LABELS`,
`ENHANCEMENTS_LABEL`). The card-level allowlists are no longer subtracted wholesale. A
second copy of a label, a label with no list after it, or a renamed label is left over, and
the coverage check reports it with its whole text.

A card is a unit iff it has a `div.bg-slate-200` whose whole text reads `YOUR … COST(S)`
(`TIER_LABEL_RE`, now anchored) and whose next sibling is a `ul.leaders`. Every tier label in
the fixtures is one of seven (`YOUR UNIT COSTS` … `YOUR 4TH + UNIT COSTS`) and sits right
before its list once the page is hydrated, even in `black-templars.html`, where the label
and list stream in separate chunks.

## Consequences
- Every card of every fixture is classified as before and parses to the same data, and the
  live site's 30 pages scraped on 2026-10-23 matched `data/` byte for byte.
- A block GW empties now fails the faction where it used to pass. That is the point: an
  empty Leader list is a change worth a look, not chrome.
- `PAGE_BOILERPLATE` is still subtracted wholesale: the page level has no blocks to tie its
  headings to.
- The browser render still waits on a count of cards holding a tier label, without the
  `ul.leaders` condition: every unit card has one, and the count only needs to grow.

Rejected:
- **Counting each allowlisted label at most once per card**, without tying it to its block.
  It reports a second `SUPPORT`, but not a label whose list is gone.
