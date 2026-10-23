# 0035. Pair same-named units by content before position

- **Status:** accepted, for [#89](https://github.com/BSData/wh40k-11e-mfm/issues/89); revises [0014](0014-unit-identity.md)
- **Spec:** [change tracking — Which unit is which](../../specs/change-tracking.md#which-unit-is-which)

## Context
[0014](0014-unit-identity.md) pairs same-named units by their occurrence index within a
group, which is positional. Two cases show what that costs:
- Imperial Agents lists a base `Inquisitor` (55 pts) and, under `Every Model Has the
  Imperium Keyword`, another (65 pts). Move the base one into that sub-group and the moved
  unit takes index 0 there, so it is compared with the sub-group's own `Inquisitor`. The
  report says `65 → 55` and `55 → 65`, two reprices that never happened, and puts the
  `group:` line on the wrong unit.
- 0014's own consequence: if GW dropped the first Space Wolves `Venerable Dreadnought`, the
  report would say `#2` was removed and `#1` was re-tiered and moved to Legends.

## Decision
Units are paired in four passes over the new units in page order. Each pairs a new unit
with the first still-unpaired old unit in page order that fits:
1. same group and name, and the same content;
2. same group and name (0014's rule: the n-th leftover namesake, in page order);
3. same name, and the same content;
4. same name.

"Same content" means deep-equal once `groupTitle` is left out.

Pass 1 comes before pass 3 because of Imperial Agents: 15 of the 29 names on both rosters
are identical on the base roster and in the sub-group. Matching content across
groups first would pair a sub-group copy with the base copy whenever the base copy is the
one repriced, and the reprice would be reported against the wrong unit, with a `group:`
change that never happened.

## Consequences
- Both examples now read right: the Inquisitor is moved (`group: — → Every Model Has the
  Imperium Keyword`, no reprice), and dropping the first Venerable Dreadnought removes `#1`.
- Replayed on the five real updates frozen in `test/golden/`, no pairing changes.
- A namesake whose content changed still falls back to position, so a reprice plus a
  reorder in one group can still pair the wrong two. Nothing is lost, as 0014 says: every
  price is still shown.

Rejected:
- **Content matching across groups before within them.** That is the identical-pair case
  above: it pairs a sub-group copy with the base copy.
