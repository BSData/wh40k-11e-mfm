# 0010. A change sub-factions share is listed once

- **Status:** accepted, [#54](https://github.com/BSData/wh40k-11e-mfm/pull/54)
- **Spec:** [change tracking — Sub-factions](../../specs/change-tracking.md#sub-factions-a-shared-change-is-listed-once)

## Context
A sub-faction's page (`parent: Space Marines`: Black Templars, Blood Angels, Dark Angels,
Deathwatch, Space Wolves) carries the parent's whole roster, so a parent reprice arrives
once per page. Rendered faction by faction, v1.5's `Intercessor Squad — 10 models: 150 →
175` appeared six times, and 759 of the sub-factions' lines were verbatim copies of a
Space Marines line: 73% of a 116,568-character body was that one family.

## Decision
Sections are rendered per family, each change listed once: under the parent when a
sub-faction shares it verbatim with the parent, in one `<Parent> sub-factions — shared`
section when every changed sub-faction shares it but the parent doesn't (v1.5 gave all
five the same sixteen units the parent already had), and otherwise in the sub-faction's
own section, which says how many of its changes are listed elsewhere.

## Consequences
This is presentation only. The table and the Discord message still count every faction's
changes in full: a Blood Angels player's question is how much of *their* army moved,
shared or not. A change two or three sub-factions share, but not all of them, stays in
each of their sections: a section for every subset of a family would be harder to read
than the repetition it saves.

A unit label is per faction ([0014](0014-unit-identity.md)), so a line naming a
disambiguated unit, like Space Wolves' `Venerable Dreadnought (#2)`, no longer reads
verbatim like the parent's, and a shared reprice of it is listed under both.
