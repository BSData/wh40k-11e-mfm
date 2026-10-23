# 0002. Name and date an update from the data

- **Status:** accepted, [#37](https://github.com/BSData/wh40k-11e-mfm/pull/37) (dates) and [#38](https://github.com/BSData/wh40k-11e-mfm/pull/38) (the version); revised by [0038](0038-a-rules-change-dates-the-update.md): a rules change beside faction changes counts as today too
- **Spec:** [change tracking — Naming an update](../../specs/change-tracking.md#naming-an-update)

## Context
An update PR is **sticky**: its branch is force-pushed on every run while its version is
live, so an update is not a single day's event. Stamping "now" on the title would re-date
the PR every day, force-push it even when nothing new was found, and lose the day the
update actually began.

Naming an update after the faction that happens to sort first is wrong too. Factions move
together, but a page can lag a revision behind.

## Decision
- The window is read from the `firstSeen` stamps of the factions in the change set: the
  earliest and the latest. A one-day update reads `2026-08-31`; one that accumulated
  changes over several days reads `2026-08-31 → 2026-09-02`.
- A re-scrape must not re-stamp what the open PRs already captured, so the workflow hands
  the scrape every open update branch's `data/` (`--dates-from`), and `firstSeen` resolves
  to the **oldest** snapshot whose content matches what was just scraped.
- The version is the site-wide one from `meta.yaml`; failing that, the one most factions
  carry, ties going to the higher version so the answer doesn't depend on directory order.

## Consequences
A run that finds nothing new reproduces the branch byte for byte: no force-push, and the
PR keeps its start date. A later change stamps only the factions that moved, widening the
window. A value that reverts to the committed one resolves back to the committed date
instead of looking like a change.

What has no stamp of its own is dated today: a removed faction, and a change to the rules
panels alone (see [0015](0015-diff-the-rules-panels.md)), which is re-dated by each
re-scrape until it merges. A stamp in `meta.yaml` would fix that, as a data-shape change.
