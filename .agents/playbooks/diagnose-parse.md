# Playbook: Diagnose a broken parse

Use this when `pnpm scrape` fails, a test breaks, or a faction's YAML looks wrong.
The expected cause is the MFM site changing its HTML. Work top-down; don't guess.

## 1. Reproduce offline
```bash
pnpm test            # do the fixture-based tests fail, or only the live scrape?
```
- **Tests pass, live scrape fails** → the site markup drifted from the fixture. Go to 2.
- **Tests fail** → someone changed the parser/model. Read the failing assertion and the
  snapshot diff (`test/__snapshots__/`).

## 2. Refresh the fixture and see what moved
```bash
pnpm refresh-fixtures
git diff --stat test/fixtures        # how much changed?
pnpm test                            # which assertions now fail?
```
Re-read [`../../specs/scraping.md`](../../specs/scraping.md) — especially the selector
table and the **streaming-points** detail (`<template id="P:N">` ↔ `<div hidden id="S:N">`,
swapped by hex suffix). That mechanism is the most likely thing to break.

## 3. Locate the drifted selector
Compare expectation vs. reality with a throwaway cheerio probe (delete it after):
```bash
node --input-type=module -e '
import {load} from "cheerio"; import {readFileSync} from "node:fs";
const $=load(readFileSync("test/fixtures/necrons.html","utf8"));
console.log("unit names:", $("div.bg-slate-500.text-xl").length);
console.log("detachments:", $("span.text-xl.break-all").length);
console.log("completions:", $("div[hidden][id]").length);'
```
Check the selector table in the spec against what the new markup actually uses
(class names, the `$RS(...)` swap function, the `P:`/`S:` id prefixes).

## 4. Fix, then re-baseline
- Update the selector in `src/parse.ts` **and** the table in `specs/scraping.md`.
- If the data shape changed, update `src/model.ts` and `specs/data-model.md` first.
- Re-run and update snapshots intentionally:
```bash
pnpm test -u
pnpm scrape --faction necrons --out /tmp/check   # eyeball the YAML
pnpm check && pnpm typecheck
```

## "Unconsumed content" errors (the completeness coverage check)
A parse that throws `Unconsumed content on "<slug>": …` means the page now has visible
text that no selector captured — the coverage check in `assertFactionCovered()` (see the
**Completeness coverage** section of `specs/scraping.md`) caught GW adding something. The
error lists exactly what and where (`unit "…"`, `detachment "…"`, or `page-level`). Decide:
- **It's new data** (a field/section/row worth keeping) → teach the parser to capture it
  (selector + `src/model.ts` + `specs/data-model.md`), the way `unique`/`leaderTo` were added.
- **It's new chrome** (a heading, banner, nav text) → add the exact string to the relevant
  allowlist (`UNIT_BOILERPLATE` / `DETACHMENT_BOILERPLATE` / `PAGE_BOILERPLATE`) in
  `src/parse.ts`. Keep it tight and specific — a broad entry silently swallows future data.

## Browser path (Legends / notes)
If the failure is in `src/browser.ts` (Legends or the "Welcome…" notes), the site's
*interactive* bits drifted, not the markup. Re-check these landmarks against the live page:
the cookie reject button (`#onetrust-reject-all-handler`), the toggle (`#show-legends-label`,
**absent on factions with no Legends — that's expected**), the welcome trigger text, and the
notes anchor phrases (`NOTES_ANCHORS`). Debug with `chromium.launch({ headless: false })`.

## 5. Open a PR
Reference the failing scrape run / issue. Summarise what the site changed and the
selector fix. Keep the fixture refresh in the same PR so CI is green.
