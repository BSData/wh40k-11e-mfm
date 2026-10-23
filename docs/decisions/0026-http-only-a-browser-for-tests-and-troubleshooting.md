# 0026. Scrape over HTTP only; a browser for tests and troubleshooting

- **Status:** accepted, for [#92](https://github.com/BSData/wh40k-11e-mfm/issues/92); supersedes [0017](0017-http-first-a-browser-only-where-needed.md)
- **Spec:** [scraping — Legends](../../specs/scraping.md#legends-over-http), [the rules panels](../../specs/scraping.md#the-rules-panels-over-http) and [the browser](../../specs/scraping.md#the-browser-tests-and-troubleshooting-only)

## Context
[0017](0017-http-first-a-browser-only-where-needed.md) kept a headless Chromium for what a
plain GET seemed not to return: the Legends units and the two rules panels. The browser was
the slow and fragile part of the daily run. Installing it (`playwright install --with-deps
chromium`) usually took about 20 s, but its apt step depends on Ubuntu's mirrors: 484 s on
run 39874188076, and about 10 minutes in a Copilot setup run. The Scrape step took about
275 s on every run, mostly browser renders.

A check of the live site on 2026-10-23 found both in the server's answer after all:
- The "Show Legends" toggle calls a server action that sets the cookie
  `isLegendsDisplayed=true` and re-renders the page. A GET sent with that cookie returns the
  Legends server-rendered, under a `LEGENDS` section heading: Necrons have 64 units instead
  of 52.
- Opening a rules panel makes no request. Its content is in the plain page's React Server
  Components payload (the `self.__next_f.push(...)` strings), as element trees. Decoded and
  rendered to HTML, both panels convert to Markdown byte-identical to what the browser path
  wrote in `data/meta.yaml`.

## Decision
- The scrape is HTTP only: one GET per faction page, with the Legends cookie, and the index.
  Units under the `LEGENDS` section get `legends: true`. The rules panels are decoded from
  the first faction page's payload.
- A panel is found through its collapsible, the component whose trigger's label is the
  panel's button text, not through the headings inside it, which are the content that
  changes.
- Anything unexpected fails loud: a Legends toggle with no `LEGENDS` section (the cookie
  stopped working), a page with no base roster, a panel not found exactly once, or a panel
  holding a client component or a reference the decoder doesn't know.
- A browser stays for tests and troubleshooting only: `playwright-core` with
  `channel: 'chrome'`, the Google Chrome that GitHub's Ubuntu runner images ship and
  contributors already have. Nothing installs a browser. `mfm scrape --browser` cross-checks
  the HTTP result against Chrome's render, finding the Legends by difference as 0017 did, and
  the scrape workflow's `cross-check` input runs it on demand.

## Consequences
- The daily run installs nothing and makes 31 requests; a Legends faction no longer costs a
  page load with all its scripts.
- The scrape now depends on two undocumented details: the cookie's name and value, and the
  shape of Next.js's flight payload (rows, `I` client references, `["$", type, key, props]`
  elements). Either changing fails loud and located rather than dropping data, and the
  cross-check shows which side moved.
- One request per faction can't show that a single base unit disappears when Legends are
  shown, which 0017's diff caught on every run. That check now runs with the cross-check, on
  demand.
- Rejected: keeping the browser (the cost above); running the page's scripts in jsdom
  (heavy, and as fragile); calling the toggle's server action directly (its id changes with
  every deployment); finding a panel by its first and last headings, as the proof of concept
  did (a heading GW renames would lose the panel without saying why).
