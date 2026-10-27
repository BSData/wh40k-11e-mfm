# Spec: Scraping & parsing

Implemented by [`src/fetch.ts`](../src/fetch.ts) (HTTP) and
[`src/parse.ts`](../src/parse.ts) (HTML → model; modules under [`src/parse/`](../src/parse)),
run by [`src/scrape.ts`](../src/scrape.ts) (`pnpm scrape`). Read this before touching
them, especially if a parse has started failing. Why each rule below exists is in the
[decision records](../docs/decisions/README.md) it links.

## Source
- Landing page: `https://mfm.warhammer-community.com/en`
- Faction page: `https://mfm.warhammer-community.com/en/<slug>`
- The site is **Next.js (App Router), server-rendered**. Everything the scraper reads is in
  the HTML of a plain GET, with no JS execution and no browser:
  - the units and detachments, in the server-rendered markup;
  - the Legends units, server-rendered too when the request carries the
    `isLegendsDisplayed=true` cookie (see [Legends](#legends-over-http));
  - the rules panels ("Welcome…" and "Muster Armies"), in the page's React Server
    Components payload (see [The rules panels](#the-rules-panels-over-http)).

  A browser is only for tests and troubleshooting (see [The browser](#the-browser-tests-and-troubleshooting-only)).
  See [0026](../docs/decisions/0026-http-only-a-browser-for-tests-and-troubleshooting.md).

## Fetch policy
- Native `fetch` with a descriptive User-Agent.
- One GET per page: the index, then each faction page, which is sent with the cookie
  `isLegendsDisplayed=true` (`LEGENDS_COOKIE`). A full run makes 31 requests.
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
and in isolation. A card is a **unit** iff it has a `div.bg-slate-200` tier label reading
`YOUR … COST(S)` (its whole text: `TIER_LABEL_RE`) **immediately followed by** its
`ul.leaders`; otherwise it is a **detachment**. A change note is a `div.bg-slate-200` too, and
one with "COST" in it (`ENHANCEMENT COSTS CHANGED`) must not make a detachment a unit. This
holds in both header styles (plain and "changed") and whether or not the annotation layer is
present.

| Datum | Selector |
|---|---|
| Site version | first `vX.Y` match in body text |
| Faction links | `a[href]` matching `^/en/<slug>$`; link text = display name |
| Card | `div.flex.flex-col.space-y-1.m-1`; unit iff it has a `div.bg-slate-200` label whose whole text reads `YOUR … COST(S)` (`TIER_LABEL_RE`) and whose next sibling is a `ul.leaders`, else detachment |
| Card name | header (first child) — a `span.text-xl` inside it if present (detachment / "changed" header), else the header div's own text (plain `div.bg-slate-500.text-xl` unit header) |
| Unit `groupTitle` / faction `parent` | `h3.font-header:not([class*="break-after"])` sub-group headers (the UNITS/DETACHMENTS section headings are `h3.font-header` *with* the break-after class). Walking headers + cards in document order, each unit takes the sub-group header it sits under as `groupTitle`; a section header resets to the base roster. A sub-group header that names another faction from the index is also surfaced as the faction-level `parent` |
| Unit pricing tier | each tier label as above (`tierLabels`) + the `ul.leaders` right after it (label → `range`). No other `div.bg-slate-200` is read as a tier: a note beside a label is left over for the coverage check ([0039](../docs/decisions/0039-a-tier-is-read-only-from-a-tier-label.md)) |
| Unit cost row | `ul.leaders > li` (post-hydration): trailing `NN pts` = points, rest → `models`/`desc` |
| Unit roles | `img[src$="leader.svg"]`/`img[src$="support.svg"]`; each block's sibling span = its comma-separated list → `leaderTo`/`supportTo`. **Every** block is read: since v1.4 a unit can carry both, with a different list for each. Each block's label (`LEADER`, `SUPPORT`) is consumed once, with its list |
| Unit wargear | `img[src$="cog.svg"]` block → `ul li`: `per <item>` + `NN pts`. The block's label (`WARGEAR OPTIONS`) is consumed once, with its rows |
| Detachment DP badge | `span.self-end` in the header, the whole of it `NDP` (e.g. `2DP`) |
| Detachment objectives | `div[style]` (styled banner) under the header — **all** of them, since v1.4 a detachment can grant two Force Dispositions |
| Detachment `unique` | direct-child `div.bg-slate-200` whose text starts `UNIQUE:` (prefix stripped) |
| Enhancement | `ul.leaders li` without `no-leaders`: last `div`'s two spans = name, points |
| Enhancement `leaderTo` / `supportTo` | a following sibling of the enhancement's `<li>` (an `li.no-leaders` on the pages fetched with the Legends cookie in Oct 2026; earlier a `div` in the same wrapper): span `LEADER:`/`SUPPORT:` + next span (comma-separated unit list) |

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
| Any visible string no parse step consumed (an unknown change note, a new field, a DP badge that isn't `NDP`, a block label read twice or without its list) | `Unconsumed content on "<slug>"`, one line per card: `unit "<CARD>": "<leftover>"` (see below) |
| A page fetched with the Legends cookie that ships the Legends toggle but no `LEGENDS` section | `"<slug>": the page has the Legends toggle but no LEGENDS section …` |
| A page whose every unit is in the `LEGENDS` section | `"<slug>": every unit is in the LEGENDS section, so the base roster is missing` |
| On a full run, a rules panel not found in the page's RSC payload, found more than once, holding something the decoder can't render, or without text, or the page it is read from not loading | A failure named `rules panels` (see [The rules panels](#the-rules-panels-over-http)) |
| With `--browser`: a faction or the rules panels differing from the browser render | `"<slug>": the browser render differs from the HTTP page, from line <n>: …` (for a panel, the `rules panels` failure) |
| With `--browser`: a base unit missing from the browser's Legends render | `"<slug>": base units missing from the Legends render: …` |

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
  list, each wargear row, and each block's label, once, with the block it heads
  (`UNIT_BLOCK_LABELS`: `LEADER`, `SUPPORT`, `WARGEAR OPTIONS`), must add up to the whole
  card's text. Any leftover throws.
- **Per detachment card** — the name, the DP badge, every objective, the `UNIQUE:` banner,
  each enhancement's name and points, each grant's `LEADER:`/`SUPPORT:` keyword and list,
  and the `ENHANCEMENTS` heading, once, with the list it heads (`ENHANCEMENTS_LABEL`), must
  add up to the whole card.

A label is consumed only by the step that read its block, and only when it reads exactly as
listed: a second copy (an unknown note `SUPPORT`), a label with no list, or a renamed label
is left over, and is reported whole (`LEADER UPDATED`, not `UPDATED`). See
[0036](../docs/decisions/0036-a-label-counts-once-with-its-block.md).

The coverage runs on the **de-annotated** DOM, so only an *unrecognised* change note is
left of the annotation layer, and it is caught here.
- **Page level** — after dropping the parsed cards, the site chrome (`header`/`nav`, the
  `footer` of legal links, the OneTrust cookie dialog on browser renders, the rules panels
  when a browser has opened them), the army-group title (`parent`), the known content-area
  headings (`UNITS`/`DETACHMENTS`/`LEGENDS`), and the rules panels' button labels (shown
  whether open or not), *nothing* may remain.

The allowlists (`UNIT_BLOCK_LABELS`, `ENHANCEMENTS_LABEL`, `PAGE_BOILERPLATE`, and the
`CHANGE_BADGE_TEXT` notes stripped by `deannotate()`) live on their own in
[`src/allowlists.ts`](../src/allowlists.ts), where code owners guard them. Genuinely new
chrome is added there, as the exact string, in a reviewed commit; new *data* is taught to
the parser. Keep the allowlists tight.

## Legends (over HTTP)
A visitor sees a faction's Legends units after clicking the "Show Legends" toggle, which the
server ships (`input#show-legends`) only for factions that have Legends. The toggle calls a
server action that sets the cookie `isLegendsDisplayed=true` and re-renders the page. A GET
that sends the cookie gets that page server-rendered: the base roster as without it, then
the Legends in a section of their own under a `LEGENDS` section heading (an
`h3.font-header` with the break-after class), streamed in a Suspense chunk like the rest of
the page, which `hydrate()` puts in place.
- `parseFaction` reads the sections in the same document-order walk that assigns
  `groupTitle`: every unit under the `LEGENDS` section heading gets `legends: true`, until
  another section heading. A sub-group header inside the section sets `groupTitle` as it
  does anywhere else.
- The scrape fetches every faction page with the cookie (`legendsShown`), so a toggle with no
  `LEGENDS` section means the cookie no longer worked, and fails the faction. A page whose
  every unit is in the `LEGENDS` section fails too, on any page: the base roster is missing.
- One request can't show that a single base unit drops out when the Legends are shown:
  that takes the page without the cookie as well. The browser cross-check makes that
  comparison on demand (see [The browser](#the-browser-tests-and-troubleshooting-only)).

## The rules panels (over HTTP)
The two collapsible panels, "Welcome…" (help text on reading the MFM) and "Muster Armies"
(the army-building rules, including the battle-size table), aren't in the page's HTML until
a visitor opens them, and opening them makes no request: their content is already in the
page's **React Server Components payload**, the "flight" data Next.js streams into the page
for React. `rulesPanels()` in `src/parse/panels.ts` decodes it with `src/parse/rsc.ts`:
- **The payload** is the JSON strings of the page's `self.__next_f.push([1,"…"])` scripts,
  joined. It is a list of rows: `<hex id>:<JSON>` up to a newline, or
  `<hex id>:T<hex byte length>,<text>` for a long text. A row starting `I` names a client
  component: `I[<module>, <chunks>, "<export name>"]`.
- **An element** is `["$", type, key, props]`. A type that is a tag name (`"div"`) is an
  HTML element; a type `"$L<id>"` is the client component that row `<id>` names. A string
  `"$<id>"` or `"$L<id>"` stands for row `<id>`'s value, `"$$…"` is a string starting `$`,
  and `"$undefined"` is nothing. A `T` row's text is taken as is: React writes long strings
  there unescaped, so a leading `$` in it is text, not a reference.
- **A panel** is found through its collapsible, not its headings: the `Collapsible` element
  whose `CollapsibleTrigger` child's text (its `render` element, the button) starts with
  the panel's button label (`RULES_PANELS` in `src/parse/panels.ts`). Its
  `CollapsibleContent` child's children are the panel.
- **Rendering** the panel to HTML takes its tags, their string, number and `true` props as
  attributes (`className` → `class`, `htmlFor` → `for`), and its text, escaped. Props that
  are other references (an action such as `"$h1"`, `"$undefined"`) aren't attributes and
  are dropped. Inside the panel, a client component, `dangerouslySetInnerHTML`, a `$`
  reference other than those above, or a row reference to a row with no value (missing, an
  `E` error row, an `I` row) fails it: plain HTTP can't know what those render to, and
  rendering them as nothing would drop rules text without a word.
- That HTML goes through the same Markdown conversion as a panel a browser has opened:
  `extractNotesMarkdown()` / `extractMusterMarkdown()` find an open panel on a rendered page
  (button label → `aria-controls` → panel), and both paths convert with
  [node-html-markdown](https://github.com/crosstype/node-html-markdown) — `<b>` →
  `**bold**`, `<ul>/<li>` → bullets, `<table>` → GFM tables. The one project-specific step:
  the site marks section labels up as a plain `<b>` alone on its line, so an all-caps one is
  promoted to a `##` heading first. → `meta.notes` and `meta.muster`.
- The panels are identical across pages, so a full run decodes them from the first
  faction's page, with no request of its own. They are required: if either panel isn't
  found exactly once, can't be rendered, or has no text, or that page doesn't load, the
  run records a failure named `rules panels` (in the `--report` file, exit code 1) and does
  **not** write `meta.yaml`. The factions are still scraped and written. A `--faction` run
  writes no `meta.yaml`.
- When a full run writes `meta.yaml`, it also deletes each faction file in `--out` whose
  slug the index no longer lists. `meta.yaml`'s `factions` are the slugs scraped, so when
  every listed faction is scraped, `--out` holds exactly the factions `meta.yaml` names. A
  listed faction that fails keeps the file it had, which `factions` then leaves out, and
  the run exits 1, so no update PR is made from it. A run that writes no `meta.yaml`
  deletes nothing. A `*.yaml` in `--out` that doesn't read as a faction file (and isn't
  `meta.yaml`) is never deleted: the run throws, naming it. See
  [0034](../docs/decisions/0034-a-faction-the-site-drops-is-deleted.md).

## The browser (tests and troubleshooting only)
`src/browser.ts` drives Google Chrome with
[`playwright-core`](https://playwright.dev/docs/browsers#google-chrome--microsoft-edge),
`channel: 'chrome'`: the Chrome installed on the machine, which GitHub's Ubuntu runner
images ship and contributors have. Nothing installs a browser: not `pnpm install`, not a
workflow, not `scripts/setup`. The scrape loads it only with `--browser`. It is used by:
- `mfm scrape --browser`: the cross-check below; the scrape workflow's `cross-check` input
  runs it on the runner's Chrome;
- `mfm render <slug> [--legends | --panels]`: a faction page as Chrome renders it, for
  troubleshooting;
- `mfm refresh-fixtures`, for the two browser-render fixtures: `necrons-legends.html`
  (after "Show Legends") and `necrons-panels.html` (the Legends shown, then both panels
  opened; the tests use it as the toggled v1.6 render).

A render interacts only with the page's buttons and reads the rendered DOM, never the
request or response. Each page gets a fresh browser context, so no Legends cookie
carries over from another page; a render first declines cookies
(`#onetrust-reject-all-handler`).
- **Legends**, on a page that has them (it ships `input#show-legends`): wait for the
  toggle's label `#show-legends-label`, which appears once React hydrates, keep the page's
  default render, click the label, and wait for the number of **unit cards** to exceed the
  default one. A unit card is counted by its tier label: the card container holding a
  `div.bg-slate-200` label matching `TIER_LABEL_RE` (`YOUR … COST(S)`). The parser also
  requires the `ul.leaders` after it, which every unit card has, but a count to wait on
  needn't. Cards are not counted by the plain `div.bg-slate-500.text-xl` header, which
  "changed"-style headers don't have. The Legends render in a single React commit, so the
  count jumps straight to the full total.
- **The rules panels**: click each panel's button and wait for the panel it controls
  (`aria-controls`) to have content.

**The cross-check** (`--browser`) compares the HTTP result with what Chrome shows a visitor:
- For each faction, `markLegends(default, toggled)` finds the Legends the other way: by
  difference, the units only the toggled render has, matched on `groupTitle` + `name` +
  occurrence (the *n*-th unit of that name in that sub-group, in page order), because one
  page can list two units of the same name. Every unit of the default render must be in the
  toggled one, or the faction fails. The result must equal the HTTP result, compared as
  YAML in page order; a faction without Legends compares its default render.
- On a full run, the panels Chrome opens, converted by `extractNotesMarkdown()` /
  `extractMusterMarkdown()`, must equal the decoded ones.
- A difference fails that faction, which then isn't written (or `rules panels`, and
  `meta.yaml` isn't written), naming the first line that differs. So does a render that
  fails twice. If Chrome doesn't start at all, the run stops after the index, before any
  faction page, with no `--report` file.

## Known faction count
30 faction slugs as of v1.0. If `parseIndex` returns a very different number, the index
markup likely drifted.
