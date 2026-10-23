# 0017. Plain HTTP first, a browser only where the page needs one

- **Status:** accepted, with the Legends and notes capture (`c097799`); the rules panels in [#52](https://github.com/BSData/wh40k-11e-mfm/pull/52)
- **Spec:** [scraping — Legends & the rules panels](../../specs/scraping.md#legends--the-rules-panels-browser-only)

## Context
The MFM is server-rendered: a plain GET returns every unit and detachment a faction page
shows by default. Two things are not in any HTTP response. The Legends units appear only
after the client-side "Show Legends" toggle, and the two rules panels ("Welcome…" and
"Muster Armies") render only when their buttons are clicked. A headless browser is slow,
heavy to install, and less deterministic than parsing HTML.

## Decision
- Base data is parsed from plain HTTP, which is deterministic and fast.
- Only factions whose raw HTML ships the Legends toggle open the browser. The Legends are
  found by diffing the HTTP parse against the parse of the toggled render, rather than by
  reading the browser's network traffic, so nothing depends on the request or response
  shape.
- The rules panels are identical on every page, so a full run renders them once.
- `--no-legends` skips the browser entirely, for quick runs.

## Consequences
The browser waits on something the page guarantees: the Legends arrive in a single React
commit, so the wait for the unit count to rise is exact, even under concurrency. A run
without a browser has no Legends and no rules text.
