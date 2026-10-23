# 0027. Flag what looks like a misread, not just what changed

- **Status:** accepted, [#76](https://github.com/BSData/wh40k-11e-mfm/issues/76)
- **Spec:** [change tracking — Needs attention](../../specs/change-tracking.md#needs-attention)

## Context
The parser fails loud on markup it can't read ([0020](0020-fail-loud-and-located.md)),
but a misread that still parses passes every check. A cost read from the wrong column or
a units list cut short reaches the update PR as an ordinary change, among the hundreds a
revision brings: v1.5's first update PR alone had 996 point changes. A reviewer checking
them against the site has no way to tell which ones to look at first. A faction that
vanished from the index didn't reach the PR at all: the scraper deletes no file, so its
old one stays, and only `meta.yaml`'s list of factions changes, which the diff ignored.
That body said `No changes detected.`

## Decision
`collectAttention()` flags the few kinds of change that are rare in a real update and
typical of a misread: a faction gone (from the snapshot, or from the index), a faction
that lost more than half its units, a value that dropped to 0 or changed threefold either
way, and a new version with nothing else in it. The PR body lists them first, under **Needs attention**; the Discord summary
counts them; the update PR gets a `needs-attention` label while it has any.

The thresholds come from the real updates, #42, #53, #63, #64 and #78, replayed one by
one from `data/` as it was in git history, frozen under `test/golden/`:

| every update from v1.4 to v1.6 | largest so far | flagged at |
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

Cheap items are where a real change can reach the factor: 299 of the 4,165 values in
v1.6 are 10 points or less, where ×3 is one step of +10 or +20, and v1.5 had a 10 → 25. Expect
an occasional flag on a real change there, which takes a reviewer a moment to confirm.

Rejected: an absolute floor on the threefold rule (say, at least 20 points). It would
hide exactly those flags, and with them a misread of a cheap item.

Left for later: deleting the file of a faction the index no longer lists, so the dataset
drops it and the diff reports it like any other removal. That changes what `data/` holds
for its users, so it is a decision of its own.
