# 0037. A new cost row is checked against its unit, per model

- **Status:** accepted, for [#89](https://github.com/BSData/wh40k-11e-mfm/issues/89)
- **Spec:** [change tracking — Needs attention](../../specs/change-tracking.md#needs-attention)

## Context
[0027](0027-flag-what-looks-like-a-misread.md) flags a cost that moved threefold, but only
a cost that has a value on both sides: a row whose key (`unit · tier · option`) is in both
snapshots. A row new to its unit has no old value, and an option new in a re-tier has none
either, so neither was ever looked at. That is where a misread model count lands. Read
`10 models: 85` as `1 model: 850` and the diff sees a removed row and an added one; the
added one is just "new", and nothing flags it.

## Decision
A cost option its unit didn't have is measured against the unit's old options, by price per
model (`points / models`), at the existing ×3 ([`FACTOR`](../../src/diff/attention.ts)):
- **Which rows.** A new row of a unit whose tiers are unchanged, and each option new in a
  re-tier (the first of its costs, in tier order, that needs attention says why).
- **The reference.** The price per model of every old row of the unit, all tiers: the
  lowest and the highest. A new price per model above the highest is measured from it, one
  below the lowest from that, by the same rule as a value that changed (`valueNote`).
- **Add-ons, and rows of no models,** have no price per model: an add-on prices an extra,
  not models. They aren't measured. A new row at 0 points is flagged whatever kind of row
  it is.
- **Removed rows aren't checked.** A removal brings no value to look at: a misread that
  renames a row is a removal plus an addition, and the addition carries the misread value.
  Checked against the unit's new rows it would flag nothing in the real updates either,
  and catch nothing the new-row check doesn't.

## Consequences
Replaying the five real updates (v1.3 to v1.6, #42, #53, #63, #64 and #78, frozen under
`test/golden/`): 21 cost rows were new to their unit, the options new in re-tiers
included. The furthest from the range of its unit's old rows was ×2.55 per model:
Ghazghkull Thraka in v1.4, a new `1 model: 300` against his old `2 models: 235` (117.5 a
model), the unit having gone from two models to one. The next was ×2.00 (Custodian Wardens,
v1.6). So ×3 flags none of them, and the test that replays the updates keeps it so.

A real change can still trip it, and a composite row that mixes a character and a sidekick
is where one comes closest: the reviewer confirms the line on the site, as with any flag.
A misread that leaves the price per model within ×3 of the unit's old range isn't flagged,
and the rest of the review is still what catches it.

Rejected: comparing a new row with the unit's other *new* rows. A misread can corrupt
several of them together, and then they agree with each other.
