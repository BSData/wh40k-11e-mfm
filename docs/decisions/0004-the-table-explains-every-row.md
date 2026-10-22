# 0004. The summary table explains every row

- **Status:** accepted, [#37](https://github.com/BSData/wh40k-11e-mfm/pull/37) (in-place counts) and [#38](https://github.com/BSData/wh40k-11e-mfm/pull/38) (the shared note)
- **Spec:** [change tracking — The table must explain every row](../../specs/change-tracking.md#the-table-must-explain-every-row)

## Context
The Units and Detachments columns first counted whole entities added and removed. A
routine MFM update adds and removes nothing: it reprices, re-tiers and edits. So both
columns read `—` on every row, and a faction whose changes were all re-tiered cost rows or
attribute edits showed an all-`—` row above a section full of changes.

An MFM revision also bumps **every** faction's version at once. Tagging that note onto
only the rows that had nothing else to show reads as "these are the ones that bumped",
which is exactly backwards.

## Decision
- The columns count entities changed in place (`~`) as well as added and removed, so a
  non-empty section is always visible in its row.
- A version or parent note every changed faction carries is a fact about the update, not
  about any one faction: it is stated once in the summary line (`all v1.2 → v1.3`) and
  left off the rows. A note only some factions carry stays on their rows, where it is the
  reason a row with nothing to count is listed.

## Consequences
The Discord summary uses the same tallies (`tallies()`/`totals()`), so the two can't
report different numbers for one update. The per-faction sections keep their own note
either way, so a section read on its own is still true.
