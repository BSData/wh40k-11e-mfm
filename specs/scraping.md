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

## The change-annotation layer (second most important)
After a points update GW decorates the cards it changed with a **"changed since the last
MFM"** layer, and `deannotate()` (run right after `hydrate()`) strips it back to the plain
shape so a changed card parses identically to an unchanged one:
- The affected card's header is **recoloured** (`bg-red-500` for a rise, `bg-emerald-600`
  for a drop, `bg-amber-500` for both) and its name moves from the header div's own text
  into a `span.text-xl` inside a flex-row header, with a small `▲`/`▼`/`▲▼` **direction
  badge** span appended. (A detachment's `NDP` badge likewise becomes `NDP ▼`.)
- Each moved cost cell reads `▲ (+N) NN pts` / `▼ (-N) NN pts` — the glyph and `(±N)` delta
  in front of the (already-new) points.
- A trailing **`UPDATED`** badge div, optionally followed by a note div
  (`FORCE DISPOSITION(S) CHANGED`, `REQUISITION THRESHOLDS REMOVED`, `UNIQUE TAG REMOVED`).

None of this is data — the current points are the `NN pts` value and the change history is
the git diff of `data/` — so `deannotate()` removes the `UPDATED`/note badge divs and strips
the `▲`/`▼` glyphs and `(±N)` deltas from the text. A note string it does **not** recognise
is left in place so the coverage check surfaces it (add the exact string to `CHANGE_BADGE_TEXT`
in a reviewed commit). Because the layer restyles headers, the parser keys off the **card
container**, not the name element (see below).

## Selectors (the drift-prone surface)
Every unit and detachment is one **card** — `div.flex.flex-col.space-y-1.m-1` — parsed whole
and in isolation. A card is a **unit** iff it carries a `YOUR … COST(S)` tier label
(`div.bg-slate-200` matching `/COST/`); otherwise it is a **detachment**. This holds in both
header styles (plain and "changed") and whether or not the annotation layer is present.

| Datum | Selector |
|---|---|
| Site version | first `vX.Y` match in body text |
| Faction links | `a[href]` matching `^/en/<slug>$`; link text = display name |
| Card | `div.flex.flex-col.space-y-1.m-1`; unit iff it has a `div.bg-slate-200` label matching `/COST/`, else detachment |
| Card name | header (first child) — a `span.text-xl` inside it if present (detachment / "changed" header), else the header div's own text (plain `div.bg-slate-500.text-xl` unit header) |
| Unit `groupTitle` / faction `parent` | `h3.font-header:not([class*="break-after"])` sub-group headers (the UNITS/DETACHMENTS section headings are `h3.font-header` *with* the break-after class). Walking headers + cards in document order, each unit takes the sub-group header it sits under as `groupTitle`; a section header resets to the base roster. A sub-group header that names another faction from the index is also surfaced as the faction-level `parent` |
| Unit pricing tier | `div.bg-slate-200` label + following `ul.leaders` (label → `range`) |
| Unit cost row | `ul.leaders > li` (post-hydration): trailing `NN pts` = points, rest → `models`/`desc` |
| Unit role | `img[src$="leader.svg"]`/`img[src$="support.svg"]`; sibling span = comma-separated `attachTo` |
| Unit wargear | `img[src$="cog.svg"]` block → `ul li`: `per <item>` + `NN pts` |
| Detachment DP badge | `span.self-end` in the header (e.g. `2DP`) |
| Detachment objective | `div[style]` (styled banner) under the header |
| Detachment `unique` | direct-child `div.bg-slate-200` whose text starts `UNIQUE:` (prefix stripped) |
| Enhancement | `ul.leaders li`: last `div`'s two spans = name, points |
| Enhancement `leaderTo` / `supportTo` | sibling of the enhancement's `<li>` in its wrapper: span `LEADER:`/`SUPPORT:` + next span (comma-separated unit list) |

## Validation (fail loud)
Every faction is checked against the `Faction` zod schema before writing. The parser also
throws on structural surprises (no units found, unreadable model count, unresolved points).
A failure should be loud and located, never silent bad data — see
[`.agents/playbooks/diagnose-parse.md`](../.agents/playbooks/diagnose-parse.md).

## Completeness coverage (don't silently drop new content)
The parser is a *pull* parser — it reads the selectors above and ignores everything else —
so a new section, field, badge, or row that GW adds would otherwise vanish with no error and
no diff. `assertFactionCovered()` (run last in `parseFaction`, after units/detachments are
built) closes that gap by **accounting for every visible string on the page**:
- **Per unit card** — the name + every pricing tier (label + rows) + role + wargear must add
  up to the whole card's text. Any leftover throws.
- **Per detachment card** — name + DP + objective + `unique` + enhancements (each with its
  optional `leaderTo`/`supportTo` grant) must add up to the whole card, give or take the
  `ENHANCEMENTS` heading.

The coverage runs on the **de-annotated** DOM, so the change-annotation layer (see above) is
already gone; an *unrecognised* `UPDATED` note, however, survives `deannotate()` and so is
caught here as unconsumed — exactly the loud failure we want for a new note variant.
- **Page level** — after dropping the parsed cards, the site chrome (`header`/`nav`, the
  OneTrust cookie dialog on browser renders, the `Welcome…` notes block captured into
  `meta.notes`), the army-group title (`parent`), and the known content-area headings
  (`UNITS`/`DETACHMENTS`/`LEGENDS`), *nothing* may remain.

The allowlists (`UNIT_BOILERPLATE`, `DETACHMENT_BOILERPLATE`, `PAGE_BOILERPLATE`, and the
`CHANGE_BADGE_TEXT` notes stripped by `deannotate()` — all in `src/parse.ts`) are the
**deliberate-change surface**: when GW adds genuinely-new chrome you add the exact string
there in a reviewed commit; when they add new *data* you teach the parser to capture it.
Either way the change is forced through human review rather than lost.
Keep the allowlists tight — a too-broad entry is how a real addition gets swallowed.

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
- `extractNotes()` expands "Welcome to the Munitorum Field Manual", waits for the stable
  anchor ("Leader/Support") to appear, then hands the rendered HTML to the pure
  `extractNotesMarkdown()` in `src/parse.ts`. That finds the notes block (tightest element
  carrying "To muster a Warhammer 40,000 army"; innermost on ties) and converts it to
  **Markdown** — `<b>` → `**bold**`, all-caps labels → `##` headings, `<ul>/<li>` → bullets —
  preserving its structure. Identical across pages, grabbed once → `meta.notes`.

`pnpm scrape` renders Legends factions in the browser at `--concurrency` (default 4) in
parallel; `--no-legends` skips the browser entirely. CI installs Chromium via
`playwright install --with-deps chromium`.

## Known faction count
30 faction slugs as of v1.0. If `parseIndex` returns a very different number, the index
markup likely drifted.
