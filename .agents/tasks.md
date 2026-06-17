# Backlog / known follow-ups

Lightweight, tool-agnostic task list. Keep it short; move anything substantial to a
GitHub issue.

## Ideas / nice-to-haves
- [ ] Optional LLM step to summarise the generated changelog into prose for PR bodies.
- [ ] Consider emitting a combined `data/all.json` for consumers who want one file.
- [ ] Confirm the per-battle-size max-DP rule (global, not on these pages) if ever needed.
- [ ] Tune `--concurrency` if the daily run needs to be faster/gentler.

## Done
- [x] Core scrape → validate → YAML pipeline.
- [x] React-Suspense hydration in the parser (handles fully-streamed cards).
- [x] Deterministic YAML + changelog generator.
- [x] CI + scheduled scrape workflow.
- [x] Fixtures: necrons(+legends), black-templars (composite/add-on), titan-legions (thousands).
- [x] `range` interval + numeric `models` + `desc`/`addon`; thousands-separator points fix.
- [x] `firstSeen` date, stable across no-op scrapes (`dp` = detachment's point cost).
- [x] Leader/Support roles + `attachTo`; Wargear options.
- [x] Legends units + "Welcome…" notes via Playwright (legends detected from HTML).
- [x] Parallel scrape (`--concurrency`); base over HTTP, browser only for Legends factions.
