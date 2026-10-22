# 0003. A re-tiering is a change, not an add plus a remove

- **Status:** accepted, [#37](https://github.com/BSData/wh40k-11e-mfm/pull/37)
- **Spec:** [change tracking — Re-tiering](../../specs/change-tracking.md#a-re-tiering-is-a-modification-not-an-add-plus-a-remove)

## Context
Cost rows are keyed `unit · tier · option`, so when GW changes how a unit is costed
(adding a requisition threshold, so one tier becomes `1st–2nd` / `3rd+`) every key that
unit owns is rewritten. Diffed row by row, one unchanged unit becomes a wall of removals
and additions. In MFM v1.3 eight units picked up a `3rd+` threshold and generated **45 of
the changelog's 70 add/remove lines**, not one of which was an addition or a removal in
any sense a reader cares about: the unit was still there, still doing the same thing,
priced by a new rule.

## Decision
The tier ranges a unit is priced over are its pricing scheme's identity. When they differ
between snapshots the unit is *re-tiered*: kept out of the cost-row diff and described in
one line, every option's old price against its new price in each tier.

## Consequences
Nothing is lost (a genuine 275 → 280 is still in the line), and the reader is told what
actually happened. Genuine additions and removals are untouched: v1.3's surviving 25 lines
were 24 real new Leman Russ wargear options and one real removal.
