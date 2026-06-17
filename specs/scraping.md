# Spec: Scraping & parsing

Implemented by [`src/fetch.ts`](../src/fetch.ts) (HTTP) and
[`src/parse.ts`](../src/parse.ts) (HTML → model). Read this before touching either,
especially if a parse has started failing.

## Source
- Landing page: `https://mfm.warhammer-community.com/en`
- Faction page: `https://mfm.warhammer-community.com/en/<slug>`
- The site is **Next.js (App Router), server-rendered**. The **base** data is present in
  the initial HTML, so a plain GET covers it — no JS execution required. (Legends units
  and the "Welcome…" notes are client-only and need a headless browser — see below.)

## Fetch policy
- Native `fetch` with a descriptive User-Agent.
- Retry transient failures (network error, HTTP 429, HTTP 5xx) with exponential backoff;
  fail fast on other 4xx. Pacing between pages comes from the CLI's concurrency pool, not
  a fixed delay.

## The streaming detail (most important)
The page is assembled from **React Suspense** chunks. Pieces of a card — the name, the
pricing block, even an individual model-count or points value — start as placeholders
`<template id="P:N">` / `<template id="B:N">`, and the resolved markup arrives later in
sibling `<div hidden id="S:N">` blocks. The browser stitches them with `$RS("S:N","P:N")`,
**matched by the hex suffix after the colon**. Swaps can nest (a completion may contain
further templates), and an entire unit card can be streamed.

`hydrate()` in `src/parse.ts` **replays these swaps statically**: it replaces every
`<template id>` with the inner HTML of its matching `S:` completion, repeating until
stable, then removes the consumed hidden blocks. After hydration the DOM matches the
fully-rendered page, so the rest of the parser reads plain inline text. Within a cost row
the trailing `NN pts` is the points (commas are thousands separators — `2,200 pts` →
`2200`) and everything before it is the size text; `models` is the sum of integers in that
text (with a `desc` kept when it isn't a plain "N models"), and the tier `label` parses
into the interval `range`. Enhancement points are inline and need no special handling.

## Selectors (the drift-prone surface)
| Datum | Selector |
|---|---|
| Site version | first `vX.Y` match in body text |
| Faction links | `a[href]` matching `^/en/<slug>$`; link text = display name |
| Unit card name | `div.bg-slate-500.text-xl` (text = unit name) |
| Unit pricing tier | `div.bg-slate-200` label + following `ul.leaders` (label → `range`) |
| Unit cost row | `ul.leaders > li` (post-hydration): trailing `NN pts` = points, rest → `models`/`desc` |
| Unit role | `img[src$="leader.svg"]`/`img[src$="support.svg"]`; sibling span = comma-separated `attachTo` |
| Unit wargear | `img[src$="cog.svg"]` block → `ul li`: `per <item>` + `NN pts` |
| Detachment name | `span.text-xl.break-all` |
| Detachment DP badge | last `span` in the header div (e.g. `2DP`) |
| Detachment objective | `div[style]` (styled banner) under the header |
| Enhancement | `ul.leaders li`: last `div`'s two spans = name, points |

## Validation (fail loud)
Every faction is checked against the `Faction` zod schema before writing. The parser also
throws on structural surprises (no units found, unreadable model count, unresolved points).
A failure should be loud and located, never silent bad data — see
[`.agents/playbooks/diagnose-parse.md`](../.agents/playbooks/diagnose-parse.md).

## Legends & the "Welcome…" notes (browser-only)
Two things are **not** in any HTTP response — they're rendered client-side:
- **Legends units**: revealed by the client-only "Show Legends" toggle.
- **The expandable "Welcome…" help text** (rules notes).

`src/browser.ts` (Playwright, headless Chromium) handles both, interacting only with the
button and the rendered DOM — no dependence on the request/response shape:
- **Detecting Legends** is done from the *raw HTML*: `hasLegends(html)` checks for the
  `show-legends` toggle markup, which the server ships only for factions that have Legends.
  So base data is parsed from plain HTTP, and **only Legends factions open the browser**.
- `renderWithLegends()` loads the page, declines cookies (`#onetrust-reject-all-handler`),
  clicks `#show-legends-label`, and waits for the unit count to exceed the current one.
  The Legends render in a single React commit (the count jumps straight to the full total),
  so this wait is exact and deterministic under concurrency. `markLegends()` then diffs the
  HTTP base against the rendered full DOM — units present only with Legends on get
  `legends: true`.
- `extractNotes()` expands "Welcome to the Munitorum Field Manual" and returns the tightest
  element containing the stable anchor phrases ("To muster a Warhammer 40,000 army" +
  "Leader/Support"). Identical across pages, grabbed once → `meta.notes`.

`pnpm scrape` renders Legends factions in the browser at `--concurrency` (default 4) in
parallel; `--no-legends` skips the browser entirely. CI installs Chromium via
`playwright install --with-deps chromium`.

## Known faction count
30 faction slugs as of v1.0. If `parseIndex` returns a very different number, the index
markup likely drifted.
