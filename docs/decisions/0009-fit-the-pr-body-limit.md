# 0009. Fit the PR body under GitHub's limit

- **Status:** accepted, [#54](https://github.com/BSData/wh40k-11e-mfm/pull/54)
- **Spec:** [change tracking — Fitting GitHub's limit](../../specs/change-tracking.md#fitting-githubs-limit)

## Context
GitHub caps a PR body at 65,536 characters, and `create-pull-request` enforces it by
cutting the body off mid-line with nothing but a warning in the run log. v1.5's body was
116,568 characters: it ended in the middle of Deathwatch, sixteen factions and the closing
`</details>` were simply gone, and the page gave no sign of it, while the Discord
announcement linked to it as *the* changelog. Silently incomplete output is the failure
this project exists to avoid.

## Decision
The renderer owns the limit, as `src/discord.ts` owns Discord's. `changelog()` renders the
body whole when it fits; when it doesn't, it replaces faction sections with a one-line
stub, **largest first**, so the most factions keep their detail, until it fits. A note
under the table names every shortened section and the file that has it in full.

## Consequences
The complete entry is never shortened: it is the version's changelog file
([0011](0011-a-changelog-file-per-version.md)), which the same PR commits and the body
names. Sharing within sub-factions ([0010](0010-sub-factions-share-a-change-once.md)) keeps
most updates far under the limit in the first place.
