# Decision records

Why the project works the way it does. The specs under [`specs/`](../../specs) say **what**
the contract is; each record here says why one part of it was chosen, what it replaced,
and what it costs. A spec links the records behind it.

One file per decision, numbered in the order they were written up: change tracking first, then scraping.

| # | Decision | Spec |
| --- | --- | --- |
| [0001](0001-git-is-the-change-history.md) | Git is the change history | data model, change tracking |
| [0002](0002-name-and-date-an-update-from-the-data.md) | Name and date an update from the data | change tracking |
| [0003](0003-a-re-tiering-is-a-change.md) | A re-tiering is a change, not an add plus a remove | change tracking |
| [0004](0004-the-table-explains-every-row.md) | The summary table explains every row | change tracking |
| [0005](0005-ship-the-code-you-test.md) | Ship the code you test: workflow logic in TypeScript | change tracking |
| [0006](0006-one-discord-message-per-update.md) | One Discord message per update, remembered on its PR | change tracking |
| [0007](0007-announce-how-much-moved.md) | Announce how much of each faction moved | change tracking |
| [0008](0008-leader-and-support-lists.md) | Leader and Support lists | data model, change tracking |
| [0009](0009-fit-the-pr-body-limit.md) | Fit the PR body under GitHub's limit | change tracking |
| [0010](0010-sub-factions-share-a-change-once.md) | A change sub-factions share is listed once | change tracking |
| [0011](0011-a-changelog-file-per-version.md) | A changelog file per MFM version | change tracking |
| [0012](0012-one-pr-per-version-stacked.md) | One update PR per MFM version, stacked | change tracking |
| [0013](0013-one-failure-issue-per-outage.md) | One failure issue per outage | change tracking |
| [0014](0014-unit-identity.md) | A unit is its group, name and position | change tracking |
| [0015](0015-diff-the-rules-panels.md) | Diff the rules panels | change tracking |
| [0016](0016-one-english-collation.md) | One English collation | change tracking |
| [0017](0017-http-first-a-browser-only-where-needed.md) | Plain HTTP first, a browser only where the page needs one | scraping |
| [0018](0018-the-change-layer-is-not-data.md) | The "changed since the last MFM" layer is not data | scraping |
| [0019](0019-account-for-every-visible-string.md) | Account for every visible string on the page | scraping, data model |
| [0020](0020-fail-loud-and-located.md) | Fail loud and located, one faction at a time | scraping |

## Writing one
Copy the shape of an existing record: a title that states the decision, its status and
the PR that made it, a link to the spec section it explains, then **Context** (what went
wrong or what forced a choice, with the numbers), **Decision**, and **Consequences** (what
it costs, what was rejected). Keep the contract itself in the spec: a record explains a
rule, and the spec is where the rule lives. A decision that is replaced keeps its record,
marked `superseded by NNNN`.
