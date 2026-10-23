# 0023. A dry run publishes nothing

- **Status:** accepted, [#91](https://github.com/BSData/wh40k-11e-mfm/pull/91)
- **Spec:** [change tracking — Dry run](../../specs/change-tracking.md#dry-run)

## Context
The only real test of `scrape.yml` was production. A change to the workflow met the live
site, the open update PRs and the Discord channel on its first run, and a mistake there
published something: a PR, a comment, an announcement or a failure issue.

## Decision
`workflow_dispatch` takes a `dry-run` input. A dry run runs the `scrape` job as a real run
would, then skips every job that publishes: `publish`, `announce` and `report`. What they
would have published goes to the run's summary, and the Discord payload to the log. A
separate `app-check` job mints the App's token and does nothing with it, so a dry run
also checks the App's credentials without putting the key in a job with dependency code
([0022](0022-the-app-key-never-meets-dependency-code.md)).

The failure issue is skipped both ways: a dry run neither opens nor closes one, so a
failed dry run is reported by its red run alone.

A dry run has its own concurrency group. In the scheduled run's group, a dry run queued
behind a running one would cancel a scheduled run already waiting there.

## Consequences
A workflow change can be run against today's site from its branch before it merges. The
first dry run of the four jobs, [39882594770](https://github.com/BSData/wh40k-11e-mfm/actions/runs/39882594770), ran `scrape` and `app-check`, skipped
the rest, and published nothing.

A dry run doesn't exercise `publish`, `announce` or `report`, so their first test is
still a real run. That is also why `publish` runs `harden-runner` in audit mode, not in
block mode: a wrong allowlist would first show up as a failed real run.
