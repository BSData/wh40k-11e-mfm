# 0013. One failure issue per outage

- **Status:** accepted, [#8](https://github.com/BSData/wh40k-11e-mfm/pull/8) (the located report) and [#66](https://github.com/BSData/wh40k-11e-mfm/pull/66) (one issue per outage)
- **Spec:** [change tracking — Failure reporting](../../specs/change-tracking.md#failure-reporting)

## Context
A failed scrape opened an issue saying only that the run failed, so finding *which*
faction broke, and why, meant reading the run log. And it opened one per failed run: a site
change that took two days to fix opened two identical issues ([#60](https://github.com/BSData/wh40k-11e-mfm/issues/60) and [#61](https://github.com/BSData/wh40k-11e-mfm/issues/61)).

## Decision
The scrape writes a per-faction report of the located errors (`--report`), and the issue
carries it. While a `scrape-failure` issue is open, a failed run comments on it instead of
opening another; the next successful run closes it, with a link to that run.

## Consequences
An outage has one issue and one thread. The issue's text says the source markup may have
drifted, so anything that fails the job for another reason, such as a Discord outage,
must not reach the handler ([0006](0006-one-discord-message-per-update.md)'s step is
`continue-on-error` for that reason).
