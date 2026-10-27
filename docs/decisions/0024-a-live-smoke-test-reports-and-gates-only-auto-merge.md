# 0024. A live smoke test reports, and gates only Dependabot's merges

- **Status:** accepted, [#91](https://github.com/BSData/wh40k-11e-mfm/pull/91); revised by [0040](0040-a-drift-fix-merges-itself.md): it gates a drift fix's merge too
- **Spec:** [change tracking — Live smoke test](../../specs/change-tracking.md#live-smoke-test)

## Context
CI tests the parser against saved pages, and most of them date from v1.1. A parser
change, or an update of cheerio or Playwright, can pass every test and still misread
today's site. The first anyone heard of it was the next day's failed scrape.

## Decision
`smoke.yml` scrapes the live site with a PR's code, on each PR that touches `src/`, the
dependencies (`package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml`) or `.node-version`.
It reports how the result differs from the committed `data/`, as the `mfm diff` changelog
in the job summary. A difference never fails the job: a PR that changes the output is
meant to differ, and so does any PR while the site has an update that `main` doesn't have
yet. A scrape that fails does fail it. It is read-only: `contents: read` and no secrets.

It is not a required check, since it doesn't run on every PR, so a person decides what a
red one means. The one merge no person makes, Dependabot's
([0025](0025-dependabot-minor-and-patch-updates-merge-themselves.md)), waits for it
instead.

## Consequences
A reviewer sees what a parser change does to today's data before merging it. On #91 the
first run scraped all 30 factions in about five minutes, and reported that the result
differed from `data/`.

While the site is changed or down, every PR that runs the check fails it, whatever the PR
does; the scheduled scrape fails the same way, with a `scrape-failure` issue. Each push to
such a PR is one more full scrape of the site, about five minutes.
