# 0038. A rules change dates the update, beside the factions too

- **Status:** accepted, for [#89](https://github.com/BSData/wh40k-11e-mfm/issues/89); revises [0002](0002-name-and-date-an-update-from-the-data.md) and [0015](0015-diff-the-rules-panels.md)
- **Spec:** [change tracking — Naming an update](../../specs/change-tracking.md#naming-an-update), [The rules panels](../../specs/change-tracking.md#the-rules-panels)

## Context
[0002](0002-name-and-date-an-update-from-the-data.md) dates an update from the `firstSeen`
stamps of the factions in it, and [0015](0015-diff-the-rules-panels.md) adds that a change
to the rules panels alone is dated today, since `meta.yaml` has no stamp of its own. The
second rule only held when no faction changed. The review of #86 found the gap: factions
changed on day 1 and `muster` on day 3 still titled the update `day 1`, as if the rules
change had not happened, though the PR now carries it and the Rules section is in the body.

`mfm changelog` also called `updateWindow` without the snapshots' `meta`, so its entry
heading could not see a rules change at all, and could differ from the PR title.

## Decision
- A changed rules panel (`notes` or `muster`, added, removed or changed) counts as today
  in the window, alone or beside faction changes. Beside them it stretches the window's
  last day to today.
- A change of the site version, or of `schemaVersion`, alone doesn't count. A version bump
  moves with the factions' own stamps, so it is already dated by them. Counting it would
  re-date every version PR on each daily re-scrape. A `schemaVersion` bump comes from a
  model change, which merges through an ordinary PR rather than the scrape.
- `mfm changelog` passes `meta` to `updateWindow`, so its entry heading is the PR title's
  window.

## Consequences
An open PR whose rules changed is re-dated, on its last day, by each re-scrape until it
merges. It is the cost 0002 and 0015 already accepted for a rules-only update, now paid
beside faction changes as well. The first day stays stable.

The alternative is a stamp for `meta.yaml` itself, which would date a panel change as the
factions are dated. That is a change to the files' shape, so a decision of its own.
