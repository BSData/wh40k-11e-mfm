# AGENTS.md

Guidance for coding agents and humans working in this repo. Tool-agnostic
([agents.md](https://agents.md) convention) — no vendor-specific config.

## What this is
A scraper that turns the Warhammer 40,000 **Munitorum Field Manual**
(`https://mfm.warhammer-community.com/en`) into versioned YAML, and tracks points
changes over time. Two outputs: a **clean dataset** (`data/*.yaml`) and a **change
history** (git diffs + generated changelogs). It is *not* a product with LLM features —
the AI angle is purely this maintenance harness.

## Project map
- `src/model.ts` — zod schemas; the **data-model contract** (and TS types).
- `src/parse.ts` — cheerio HTML → model. Pure. The drift-prone surface.
- `src/fetch.ts` — polite HTTP (retry/backoff).
- `src/browser.ts` — Playwright: Legends units + "Welcome…" notes (not in HTTP).
- `src/emit.ts` — deterministic YAML in/out.
- `src/diff.ts` — changelog from two snapshots (pure `changelog()` + CLI).
- `src/cli.ts` — the pipeline entrypoint (`pnpm scrape`).
- `specs/` — **source-of-truth prose**. Change the spec first, then the code.
- `test/` — Vitest + saved HTML `fixtures/`. Tests run offline.
- `data/` — committed output: the dataset and its history. Do not hand-edit.
- `.agents/playbooks/` — runbooks for common maintenance tasks.

## Commands
```bash
pnpm install
pnpm exec playwright install chromium   # once, for Legends/notes capture
pnpm test                      # offline parser/emit/diff tests (start here)
pnpm scrape --faction necrons  # live run for one faction (with Legends) → data/
pnpm scrape --no-legends       # fast HTTP-only run, no browser/Legends
pnpm scrape                    # full run, all factions → data/ + meta.yaml
pnpm refresh-fixtures          # re-download test fixtures after a site change
pnpm check                     # Biome lint+format
pnpm typecheck                 # tsc --noEmit
```
Legends units and the "Welcome…" notes aren't in the server HTML; `src/browser.ts`
(Playwright) captures them. Use `--no-legends` for quick iteration without a browser.

## Conventions
- TypeScript ESM (`.js` import specifiers), Node ≥ 22, pnpm. Biome for lint/format.
- Parsing functions stay **pure** (HTML in, model out) so they're testable from fixtures.
- All scraped data must pass `Faction.parse` before being written — fail loud, never
  emit silently-wrong data.
- Keep YAML output deterministic (see `canonical()` in `src/emit.ts`); a points change
  should be a one-line diff.

## When a scrape breaks
The MFM site changing its markup is the expected failure mode. Don't guess —
follow [`.agents/playbooks/diagnose-parse.md`](.agents/playbooks/diagnose-parse.md):
read `specs/scraping.md`, refresh the fixture, locate the drifted selector, fix, re-test.
