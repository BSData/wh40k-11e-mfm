# 0018. The "changed since the last MFM" layer is not data

- **Status:** accepted, [#25](https://github.com/BSData/wh40k-11e-mfm/pull/25)
- **Spec:** [scraping — The change-annotation layer](../../specs/scraping.md#the-change-annotation-layer-second-most-important)

## Context
After the MFM v1.1 update GW decorated every card it had changed: recoloured headers with
the name moved into a different element, `▲`/`▼` glyphs, `(±N)` deltas in front of the new
points, and `UPDATED` badges with notes. The parser keyed off the plain header, so every
restyled card fell through: 28 of 30 factions failed the completeness check
([#24](https://github.com/BSData/wh40k-11e-mfm/issues/24)).

## Decision
The layer is stripped before anything is parsed (`deannotate()`), so a changed card parses
exactly like an unchanged one; the cost-row parser strips any delta it still finds, so one
can never be counted as models. None of it is data: the current points are the `NN pts`
value, and the change history is the git diff of `data/`
([0001](0001-git-is-the-change-history.md)). The parser keys off the card container rather
than the name element, which the layer restyles.

## Consequences
Only recognised notes are stripped. A note the parser doesn't know is left in place, so the
completeness check fails on it ([0019](0019-account-for-every-visible-string.md)) and a
person decides whether it is chrome or data. The layer disappears at the next update, so
the fixtures that show it (`adepta-sororitas.html`) can't be re-downloaded and are kept.
