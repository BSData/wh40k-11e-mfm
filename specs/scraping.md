# Spec: Scraping & parsing

Implemented by [`src/fetch.ts`](../src/fetch.ts) (HTTP) and
[`src/parse.ts`](../src/parse.ts) (HTML → model; modules under [`src/parse/`](../src/parse)),
run by [`src/scrape.ts`](../src/scrape.ts) (`pnpm scrape`). Read this before touching
them, especially if a parse has started failing. Why each rule below exists is in the
[decision records](../docs/decisions/README.md) it links.

## Source
- Landing page: `https://mfm.warhammer-community.com/en`
- Faction page: `https://mfm.warhammer-community.com/en/<slug>`
- The site is **Next.js (App Router), server-rendered**. The **base** data is present in
  the initial HTML, so a plain GET covers it — no JS execution required. (Legends units
  and the rules panels — the "Welcome…" notes and "Muster Armies" — are client-only and
  need a headless browser — see below.)

## Fetch policy
- Native `fetch` with a descriptive User-Agent.
- Retry transient failures (network error, HTTP 429, HTTP 5xx) with exponential backoff;
  fail fast on other 4xx. Pacing between pages comes from the scrape's concurrency pool,
  not a fixed delay.

## The streaming detail (most important)
The page is assembled from **React Suspense** chunks. Pieces of a card — the name, the
pricing block, even an individual model-count or points value — start as placeholders
`<template id="P:N">` / `<template id="B:N">`, and the resolved markup arrives later in
sibling `<div hidden id="S:N">` blocks. The browser stitches them with `$RS("S:N","P:N")`,
**matched by the hex suffix after the colon**. Swaps can nest (a completion may contain
further templates), and an entire unit card can be streamed.

`hydrate()` in `src/parse/page.ts` **replays these swaps statically**: it replaces every
`<template id>` with the inner HTML of its matching `S:` completion, repeating until
stable, then removes the consumed hidden blocks. After hydration the DOM matches the
fully-rendered page, so the rest of the parser reads plain inline text. Within a cost row
the trailing `NN pts` is the points and everything before it is the size text; `models` is
the sum of integers in that text (with a `desc` kept when it isn't a plain "N models"), and
the tier `label` parses into the interval `range`.

Every points value — cost rows, wargear, enhancements — goes through one parser
(`parsePoints()`): a whole `NN pts`, where commas are thousands separators (`2,200 pts` →
`2200`). Anything else, such as `FREE`, is not a number of points and fails the parse (see
[Validation](#validation-fail-loud)).

## The change-annotation layer (second most important)
After a points update GW decorates the cards it changed with a **"changed since the last
MFM"** layer, and `deannotate()` (run right after `hydrate()`) strips it back to the plain
shape so a changed card parses identically to an unchanged one:
- The affected card's header is **recoloured** (`bg-red-500` for a rise, `bg-emerald-600`
  for a drop, `bg-amber-500` for both) and its name moves from the header div's own text
  into a `span.text-xl` inside a flex-row header, with a small `▲`/`▼`/`▲▼` **direction
  badge** span appended. (A detachment's `NDP` badge likewise becomes `NDP ▼`.)
- Each moved cost cell reads `▲ (+N) NN pts` / `▼ (-N) NN pts` — the glyph and `(±N)` delta
  in front of the (already-new) points. The delta is read the way points are: it may carry
  thousands separators (`(+1,000)`), and its minus may be a hyphen or `−` (U+2212).
- A trailing **`UPDATED`** badge div, optionally followed by a note div
  (`FORCE DISPOSITION(S) CHANGED`, `REQUISITION THRESHOLDS REMOVED`, `UNIQUE TAG REMOVED`,
  `BODYGUARD UNITS UPDATED`, `WARGEAR COSTS REMOVED`), on unit and detachment cards alike.

None of this is data. `deannotate()` removes the `UPDATED`/note badge divs and strips the
`▲`/`▼` glyphs and `(±N)` deltas from the text. A note string it does **not** recognise is left in place, no
parse step consumes it, and the coverage check fails the faction with `Unconsumed content`
naming the card and the note. To accept a new note, add the exact string to
`CHANGE_BADGE_TEXT` in [`src/allowlists.ts`](../src/allowlists.ts) in a reviewed commit.
Because the layer restyles headers, the parser keys off the **card container**, not the
name element (see below). See [0018](../docs/decisions/0018-the-change-layer-is-not-data.md).

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
| Unit roles | `img[src$="leader.svg"]`/`img[src$="support.svg"]`; each block's sibling span = its comma-separated list → `leaderTo`/`supportTo`. **Every** block is read: since v1.4 a unit can carry both, with a different list for each. The block labels (`LEADER`, `SUPPORT`) are allowlisted |
| Unit wargear | `img[src$="cog.svg"]` block → `ul li`: `per <item>` + `NN pts`. The block label (`WARGEAR OPTIONS`) is allowlisted |
| Detachment DP badge | `span.self-end` in the header, the whole of it `NDP` (e.g. `2DP`) |
| Detachment objectives | `div[style]` (styled banner) under the header — **all** of them, since v1.4 a detachment can grant two Force Dispositions |
| Detachment `unique` | direct-child `div.bg-slate-200` whose text starts `UNIQUE:` (prefix stripped) |
| Enhancement | `ul.leaders li`: last `div`'s two spans = name, points |
| Enhancement `leaderTo` / `supportTo` | sibling of the enhancement's `<li>` in its wrapper: span `LEADER:`/`SUPPORT:` + next span (comma-separated unit list) |

## Validation (fail loud)
Every faction is checked against the `Faction` zod schema before writing. The parser also
throws on structural surprises. A failure is loud and located, never silent bad data —
see [0020](../docs/decisions/0020-fail-loud-and-located.md), and
[`.agents/skills/diagnose-parse/SKILL.md`](../.agents/skills/diagnose-parse/SKILL.md) for
fixing one.

| Failure | Reported as |
|---|---|
| No units on a faction page | `No units found for "<slug>"` |
| A unit card with no pricing tier | `"<slug>", unit "<CARD>": no pricing tiers` |
| A cost row without a size and a trailing `NN pts`, or whose size still holds a bracket, a `▲`/`▼`, a minus before a number, or a plus before a number anywhere but the start (a delta written in a way the parser doesn't recognise; a leading `+` marks an add-on) | `"<slug>", unit "<CARD>": unreadable cost row "…"` |
| A wargear row without an item or whose points aren't `NN pts` (e.g. `FREE`) | `"<slug>", unit "<CARD>": unreadable wargear row "…"` |
| An enhancement without a name | `"<slug>", detachment "<CARD>": unreadable enhancement row "…"` |
| An enhancement whose points aren't `NN pts` (e.g. `FREE`) | `"<slug>", detachment "<CARD>": enhancement "<name>" has unreadable points "…"` |
| Any visible string no parse step consumed (an unknown change note, a new field, a DP badge that isn't `NDP`) | `Unconsumed content on "<slug>"`, one line per card: `unit "<CARD>": "<leftover>"` (see below) |
| A base unit missing from the Legends render | `"<slug>": base units missing from the Legends render: …` |
| The rules panels failing to render, or rendering without text, on a full browser run | A failure named `rules panels` (see below) |

`<CARD>` is the card's name as the page shows it (upper case), so it can be searched for in
the fixture or the live page. Each failure fails that faction (or, for the rules panels,
`meta.yaml`): the scrape carries on with the rest, lists every failure in the `--report`
file, and exits 1.

## Completeness coverage (don't silently drop new content)
`assertFactionCovered()` (`src/parse/coverage.ts`, run last in `parseFaction`, after
units/detachments are built) **accounts for every visible string on the page**, so content
the selectors above don't read fails the parse instead of vanishing. See
[0019](../docs/decisions/0019-account-for-every-visible-string.md).

Coverage means **consumed strings**: as each parse step turns part of a card into data it
records the exact text it read, and only that text counts as covered. A string a parse step
looked at but did not keep (an unparseable value, an unrecognised note, a label it doesn't
interpret) is not consumed, so it is left over and fails the parse.
- **Per unit card** — the name, each pricing tier's label and cost rows, each role block's
  list, and each wargear row, plus `UNIT_BOILERPLATE` (the `LEADER`/`SUPPORT`/`WARGEAR
  OPTIONS` block labels), must add up to the whole card's text. Any leftover throws.
- **Per detachment card** — the name, the DP badge, every objective, the `UNIQUE:` banner,
  each enhancement's name and points, and each grant's `LEADER:`/`SUPPORT:` keyword and
  list, plus `DETACHMENT_BOILERPLATE` (the `ENHANCEMENTS` heading), must add up to the whole
  card.

The coverage runs on the **de-annotated** DOM, so only an *unrecognised* change note is
left of the annotation layer, and it is caught here.
- **Page level** — after dropping the parsed cards, the site chrome (`header`/`nav`, the
  `footer` of legal links, the OneTrust cookie dialog on browser renders, the open rules
  panels captured into `meta.notes`/`meta.muster`), the army-group title (`parent`), the
  known content-area headings (`UNITS`/`DETACHMENTS`/`LEGENDS`), and the rules panels'
  button labels (shown whether open or not), *nothing* may remain.

The allowlists (`UNIT_BOILERPLATE`, `DETACHMENT_BOILERPLATE`, `PAGE_BOILERPLATE`, and the
`CHANGE_BADGE_TEXT` notes stripped by `deannotate()`) live on their own in
[`src/allowlists.ts`](../src/allowlists.ts), where code owners guard them. Genuinely new
chrome is added there, as the exact string, in a reviewed commit; new *data* is taught to
the parser. Keep the allowlists tight.

## Legends & the rules panels (browser-only)
Two things are **not** in any HTTP response — they're rendered client-side:
- **Legends units**: revealed by the client-only "Show Legends" toggle.
- **The two collapsible rules panels**: "Welcome…" (help text on reading the MFM) and
  "Muster Armies" (the army-building rules, including the battle-size table).

`src/browser.ts` (Playwright, headless Chromium) handles both, interacting only with the
buttons and the rendered DOM, never with the request/response shape. See
[0017](../docs/decisions/0017-http-first-a-browser-only-where-needed.md).
- **Detecting Legends** is done from the *raw HTML*: `hasLegends(html)` checks for the
  `show-legends` toggle markup, which the server ships only for factions that have Legends.
  So base data is parsed from plain HTTP, and **only Legends factions open the browser**.
- `renderWithLegends()` loads the page, declines cookies (`#onetrust-reject-all-handler`),
  clicks `#show-legends-label`, and waits for the number of **unit cards** to exceed the
  current one. A unit card is counted the way the parser recognises one — the card
  container holding a `div.bg-slate-200` label matching `/COST/` — not by the plain
  `div.bg-slate-500.text-xl` header, which "changed"-style headers don't have. The Legends
  render in a single React commit, so the count jumps straight to the full total.
- `markLegends()` then diffs the HTTP base against the rendered full DOM — units present only
  with Legends on get `legends: true`. Units are matched on `groupTitle` + `name` +
  occurrence (the *n*-th unit of that name in that sub-group, in page order), because one
  page can list two units of the same name. This relies on the Legends render listing the
  Legends after the base roster, under their own `LEGENDS` section heading, so of two
  same-named units the base one always comes first. Every base unit must be found in the
  full render; one that is missing fails the faction rather than being dropped.
- `renderRulesPanels()` clicks each panel's button (`RULES_PANELS` in
  `src/parse/panels.ts`) and waits for the panel that button controls (`aria-controls`) to
  have content, then hands the rendered HTML to the pure `extractNotesMarkdown()` /
  `extractMusterMarkdown()`. Those find the open panel the same way (button label →
  `aria-controls` → panel) and convert it to **Markdown** with
  [node-html-markdown](https://github.com/crosstype/node-html-markdown) — `<b>` → `**bold**`,
  `<ul>/<li>` → bullets, `<table>` → GFM tables. The one project-specific step: the site marks
  section labels up as a plain `<b>` alone on its line, so an all-caps one is promoted to a
  `##` heading first. Identical across pages, rendered once → `meta.notes` and `meta.muster`.
- On a full browser run, the rules panels are required. If the render fails, or either
  panel yields no text, after one retry, the run records a failure named `rules panels` (in
  the `--report` file, exit code 1) and does **not** write `meta.yaml`. The factions are
  still scraped and written. A `--faction` run and a `--no-legends` run don't render the
  panels and never write them (the former writes no `meta.yaml`; the latter writes one
  without `notes` and `muster`).

`pnpm scrape` renders Legends factions in the browser at `--concurrency` (default 4) in
parallel; `--no-legends` skips the browser entirely. CI installs Chromium via
`playwright install --with-deps chromium`.

## Known faction count
30 faction slugs as of v1.0. If `parseIndex` returns a very different number, the index
markup likely drifted.
