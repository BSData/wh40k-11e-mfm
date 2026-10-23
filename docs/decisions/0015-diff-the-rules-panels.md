# 0015. Diff the rules panels

- **Status:** accepted, [#86](https://github.com/BSData/wh40k-11e-mfm/pull/86); revised by [0038](0038-a-rules-change-dates-the-update.md): a changed panel counts as today beside faction changes too
- **Spec:** [change tracking — The rules panels](../../specs/change-tracking.md#the-rules-panels)

## Context
`meta.yaml` carries the site version and two rules panels, `notes` (the "Welcome…" text)
and `muster` (Muster Armies: battle sizes, DP, unit limits). They were not diffed at all,
so a change to a battle size's DP produced an update PR whose body said `No changes
detected.`

## Decision
Both snapshots' `meta.yaml` are compared. A changed panel is shown as its changed lines
only, `-` before `+`, with `…` between hunks, in a `diff` block, and no context: the reader
has the panel itself in `meta.yaml`. A panel that appears or disappears is one line rather
than all of its lines. The site version is named in the summary line unless the factions'
shared note already says it, which is the case for every MFM revision so far, so a
version change is never lost and a routine revision doesn't say it twice.

## Consequences
A rules-only update has no `firstSeen` of its own to date it by, so it is dated today, and
re-dated by each re-scrape until it merges
([0002](0002-name-and-date-an-update-from-the-data.md)).
