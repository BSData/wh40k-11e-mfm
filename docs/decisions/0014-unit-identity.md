# 0014. A unit is its group, name and position

- **Status:** accepted, [#86](https://github.com/BSData/wh40k-11e-mfm/pull/86)
- **Spec:** [change tracking — Which unit is which](../../specs/change-tracking.md#which-unit-is-which)

## Context
A unit's name is not unique within its faction. Imperial Agents lists 29 names twice, once
on the base roster and again under the `Every Model Has the Imperium Keyword` sub-group,
and 14 of those pairs differ in content. Space Wolves has two different `Venerable
Dreadnought` entries in the same group. Keyed by name, the second entry overwrote the
first: repricing the first Inquisitor reported `No changes detected.`, and two identical
Space Wolves snapshots reported a phantom re-tier. That phantom is in `changelog/v1.5.md`
and `changelog/v1.6.md`, which stay as published.

## Decision
A unit's identity is its `groupTitle`, its `name`, and its occurrence index among the units
with the same group and name, in page order, and every comparison uses it. Units left
unmatched are then paired by name, so a unit that changes sub-group reads as changed
(`group: A → B`), not as a removal plus an addition. A unit keeps its bare name in the
report unless another unit shares it; then the label adds the group and, if needed, the
position.

## Consequences
The occurrence index is positional: adding or removing a namesake ahead of another in the
same group shifts it. If GW dropped the first Space Wolves Venerable Dreadnought, the report
would say `#2` was removed and `#1` was re-tiered. Nothing is lost, as every price is still
shown, but against the neighbouring entry.
