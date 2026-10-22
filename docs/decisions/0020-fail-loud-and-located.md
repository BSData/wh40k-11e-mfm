# 0020. Fail loud and located, one faction at a time

- **Status:** accepted with the parallel scrape (`c097799`) and its failure report in [#8](https://github.com/BSData/wh40k-11e-mfm/pull/8); located errors and required rules panels in [#85](https://github.com/BSData/wh40k-11e-mfm/pull/85)
- **Spec:** [scraping — Validation](../../specs/scraping.md#validation-fail-loud)

## Context
The site changes its markup without notice, which is the failure this project expects.
Silently wrong data is worse than no update. But one faction's page drifting shouldn't hold
back the other 29, and an error that says only that the run failed sends someone to the
logs to find out where.

A rules-panel render that failed used to be caught and written as an empty panel, so a
flaky browser run removed `notes` and `muster` from `meta.yaml`.

## Decision
- Every faction is validated against its schema before it is written, and the parser
  throws on anything it can't read rather than guessing.
- A failure fails that faction only. The run carries on with the rest, writes what did
  parse, lists every failure in a report, and exits 1, which opens the failure issue
  ([0013](0013-one-failure-issue-per-outage.md)).
- An error names the faction and the card as the page shows it (upper case), so it can be
  searched for in the fixture or the live page.
- On a full browser run the rules panels are required. If they fail, that is a failure
  like a faction's, and `meta.yaml` is not written at all.

## Consequences
A partly failed run still updates the factions that parsed, in the same PR. The fix for a
drifted page starts from the error message and a saved fixture: the `diagnose-parse` skill
walks through it.
