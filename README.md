# wh40k-mfm-scraper

Scrapes the official Warhammer 40,000 **Munitorum Field Manual**
(<https://mfm.warhammer-community.com/en>) into clean, versioned YAML and tracks points
changes over time.

- **Dataset** — one human-readable file per faction in [`data/`](data/).
- **Change history** — deterministic YAML means `git log -p data/` is a precise record of
  every points change; the scheduled job opens a PR with a generated changelog whenever GW
  updates the manual.

Most data is server-rendered, so the core scrape is a plain HTTP GET + HTML parse.
**Legends** units and the expandable **"Welcome…" notes** are client-only, so those are
captured with a headless browser (Playwright); pass `--no-legends` to skip it.

## Quick start
```bash
pnpm install
pnpm exec playwright install chromium   # once, for Legends/notes
pnpm test                      # offline tests against saved HTML fixtures
pnpm scrape --faction necrons  # live run for one faction → data/necrons.yaml
pnpm scrape --no-legends       # fast HTTP-only run (no browser)
pnpm scrape                    # full run, all factions (with Legends + notes)
```

## How it stays correct
- The scraped shape is validated against zod schemas (`src/model.ts`) before writing —
  drift fails loudly instead of producing bad data.
- The parser is covered by tests over real saved pages (`test/fixtures/`), so site changes
  are caught in CI.
- A daily GitHub Action re-scrapes, opens a PR on change, and files an issue if a parse
  breaks.

## Tech
TypeScript (Node 22, ESM) · cheerio · zod · `yaml` · Vitest · Biome · pnpm.

## For maintainers / agents
See [`AGENTS.md`](AGENTS.md) for the project map and commands, [`specs/`](specs/) for the
source-of-truth contracts, and [`.agents/playbooks/`](.agents/playbooks/) for runbooks
(notably what to do when a scrape breaks).

## Disclaimer
Unofficial. Warhammer 40,000 and the Munitorum Field Manual are © Games Workshop. This
project reformats publicly available points values for personal/community reference and is
not affiliated with or endorsed by Games Workshop.
