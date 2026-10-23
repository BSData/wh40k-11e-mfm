# 0008. Leader and Support lists

- **Status:** accepted, [#41](https://github.com/BSData/wh40k-11e-mfm/pull/41) (both lists), [#49](https://github.com/BSData/wh40k-11e-mfm/pull/49) (shown as deltas) and [#54](https://github.com/BSData/wh40k-11e-mfm/pull/54) (lost targets)
- **Spec:** [data model](../../specs/data-model.md), [change tracking — How it works](../../specs/change-tracking.md#how-it-works)

## Context
- A unit had one `role` and one `attachTo` list. MFM v1.4 gave the Judiciar a Leader list
  of twelve units and a Support list of five, which that shape cannot express.
- A changed list was printed whole, before and after on one line, so the one name that
  moved had to be found by comparing two long lists.
- In v1.5, Blood Angels losing the Tactical Squad put `➖ Tactical Squad` under seven
  leaders, and 152 such lines ran across the update: the same fact, that the unit is gone,
  once per leader that used to take it.

## Decision
- A unit carries `leaderTo` and `supportTo` separately, either or both, named to match
  `Enhancement.leaderTo`/`supportTo`, which already had that shape.
- The changelog shows a list's membership changes (➖/➕ per name). It shows the whole list
  before and after only when the order of the retained members changed or a name repeats,
  so no order or occurrence is lost.
- A target the faction **lost** is left out of those lists: nothing can lead a unit that
  isn't there, and `Units removed` already says it's gone. A target the faction *gained*
  stays, because which leaders can take a new unit is news no other line carries.

## Consequences
A leader whose only change was losing such a target isn't counted as changed.
