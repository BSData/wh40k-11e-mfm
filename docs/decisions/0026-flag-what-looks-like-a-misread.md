# 0026. Flag what looks like a misread, not just what changed

- **Status:** accepted, [#76](https://github.com/BSData/wh40k-11e-mfm/issues/76)
- **Spec:** [change tracking — Needs attention](../../specs/change-tracking.md#needs-attention)

## Context
The parser fails loud on markup it can't read ([0020](0020-fail-loud-and-located.md)),
but a misread that still parses passes every check. A cost read from the wrong column, a
units list cut short or a page that vanished from the index reach the update PR as
ordinary changes, among the hundreds a revision brings: v1.5's body had 457 point changes.
A reviewer checking them against the site has no way to tell which ones to look at first.

## Decision
`collectAttention()` flags the few kinds of change that are rare in a real update and
typical of a misread: a faction gone, a faction that lost more than half its units, a
value that dropped to 0 or changed threefold either way, and a new version with nothing
else in it. The PR body lists them first, under **Needs attention**; the Discord summary
counts them; the update PR gets a `needs-attention` label while it has any.

The thresholds come from the real updates, re-run against the frozen datasets in
`test/golden/data-v1.3` to `data-v1.6`:

| v1.3 → v1.4 → v1.5 → v1.6 | largest so far | flagged at |
| --- | --- | --- |
| units a faction lost | 39% (Space Marines, v1.5: 69 of 179) | more than 50% |
| a value's change | ×2.5 (Blitz Brigade · Targetin’ Gizmos, v1.5: 10 → 25) | ×3, either way |
| a re-tiered price against its old range | ×1.82 (Shield-Captain, v1.6: 110 → 180 / 200) | ×3, either way |
| a value of 0 | none in any snapshot | any |

So none of them would have flagged anything, and the test that replays them keeps it so.

## Consequences
A flag is a pointer, not a verdict: it neither fails the run nor blocks the merge. A real
change can trip one (GW tripling a cost, or retiring most of a faction), and the reviewer
then confirms it on the site and merges as usual. A misread below the thresholds isn't
flagged, and the rest of the review is still what catches it.

The flags are computed from the same `collectChanges()` diff as the body, plus the
re-tiered units' prices, which that diff keeps out of its cost rows on purpose
([0003](0003-a-re-tiering-is-a-change.md)). They aren't written to the changelog file,
since they describe the review rather than the update.

Rejected: an absolute floor on the threefold rule (say, at least 20 points). No real
update came near the factor, so a floor would only hide a misread of a cheap item.
