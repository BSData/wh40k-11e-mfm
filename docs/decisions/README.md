# Decision records

Why the project works the way it does. The specs under [`specs/`](../../specs) say **what**
the contract is; each record here says why one part of it was chosen, what it replaced,
and what it costs. A spec links the records behind it.

One file per decision, numbered in the order they were written up: change tracking first, then scraping, then each new one as it is made.

| # | Decision | Spec |
| --- | --- | --- |
| [0001](0001-git-is-the-change-history.md) | Git is the change history | data model, change tracking |
| [0002](0002-name-and-date-an-update-from-the-data.md) | Name and date an update from the data (revised by 0038) | change tracking |
| [0003](0003-a-re-tiering-is-a-change.md) | A re-tiering is a change, not an add plus a remove | change tracking |
| [0004](0004-the-table-explains-every-row.md) | The summary table explains every row | change tracking |
| [0005](0005-ship-the-code-you-test.md) | Ship the code you test: workflow logic in TypeScript | change tracking |
| [0006](0006-one-discord-message-per-update.md) | One Discord message per update, remembered on its PR | change tracking |
| [0007](0007-announce-how-much-moved.md) | Announce how much of each faction moved | change tracking |
| [0008](0008-leader-and-support-lists.md) | Leader and Support lists | data model, change tracking |
| [0009](0009-fit-the-pr-body-limit.md) | Fit the PR body under GitHub's limit (revised by 0033) | change tracking |
| [0010](0010-sub-factions-share-a-change-once.md) | A change sub-factions share is listed once | change tracking |
| [0011](0011-a-changelog-file-per-version.md) | A changelog file per MFM version | change tracking |
| [0012](0012-one-pr-per-version-stacked.md) | One update PR per MFM version, stacked | change tracking |
| [0013](0013-one-failure-issue-per-outage.md) | One failure issue per outage | change tracking |
| [0014](0014-unit-identity.md) | A unit is its group, name and position (revised by 0035) | change tracking |
| [0015](0015-diff-the-rules-panels.md) | Diff the rules panels (revised by 0038) | change tracking |
| [0016](0016-one-english-collation.md) | One English collation | change tracking |
| [0017](0017-http-first-a-browser-only-where-needed.md) | Plain HTTP first, a browser only where the page needs one (superseded by 0026) | scraping |
| [0018](0018-the-change-layer-is-not-data.md) | The "changed since the last MFM" layer is not data | scraping |
| [0019](0019-account-for-every-visible-string.md) | Account for every visible string on the page (revised by 0036) | scraping, data model |
| [0020](0020-fail-loud-and-located.md) | Fail loud and located, one faction at a time | scraping |
| [0021](0021-names-match-the-official-ones.md) | Names match the official ones | data model |
| [0022](0022-the-app-key-never-meets-dependency-code.md) | Update PRs are opened with the App's token, in a job that runs no dependency code | change tracking |
| [0023](0023-a-dry-run-publishes-nothing.md) | A dry run publishes nothing | change tracking |
| [0024](0024-a-live-smoke-test-reports-and-gates-only-auto-merge.md) | A live smoke test reports, and gates only Dependabot's merges (revised by 0040) | change tracking |
| [0025](0025-dependabot-minor-and-patch-updates-merge-themselves.md) | Dependabot's minor and patch updates merge themselves | change tracking |
| [0026](0026-http-only-a-browser-for-tests-and-troubleshooting.md) | Scrape over HTTP only; a browser for tests and troubleshooting | scraping |
| [0027](0027-flag-what-looks-like-a-misread.md) | Flag what looks like a misread, not just what changed | change tracking |
| [0028](0028-a-schema-version-and-releases-for-consumers.md) | A schema version, and a release for every data change | data model |
| [0029](0029-a-failed-scrape-drafts-its-fix.md) | A failed scrape drafts its own fix, with the model's key and the App's key in separate jobs (revised by 0031, 0032, 0040) | change tracking |
| [0030](0030-one-short-instruction-file.md) | One short instruction file, for every harness | (AGENTS.md) |
| [0031](0031-the-drift-fixer-fails-loud-with-fewer-layers.md) | The drift fixer fails loud, with fewer layers (revises 0029) | change tracking |
| [0032](0032-one-claude-code-pin.md) | One Claude Code pin: the action installs it (revises 0029) | change tracking |
| [0033](0033-a-model-sums-up-each-update.md) | A model sums up each update in brief, and nothing depends on it (revises 0009) | change tracking |
| [0034](0034-a-faction-the-site-drops-is-deleted.md) | A faction the site drops is deleted from the data | scraping, change tracking |
| [0035](0035-pair-namesakes-by-content-first.md) | Pair same-named units by content before position (revises 0014) | change tracking |
| [0036](0036-a-label-counts-once-with-its-block.md) | A block label counts once, with the block it heads (revises 0019) | scraping |
| [0037](0037-a-new-cost-row-is-checked-per-model.md) | A new cost row is checked against its unit, per model | change tracking |
| [0038](0038-a-rules-change-dates-the-update.md) | A rules change dates the update, beside the factions too (revises 0002, 0015) | change tracking |
| [0039](0039-a-tier-is-read-only-from-a-tier-label.md) | A tier is read only from a tier label | scraping |
| [0040](0040-a-drift-fix-merges-itself.md) | A drift fix merges itself once its checks pass (revises 0024, 0029) | change tracking |

## Writing one
Copy the shape of an existing record: a title that states the decision, its status and
the PR that made it, a link to the spec section it explains, then **Context** (what went
wrong or what forced a choice, with the numbers), **Decision**, and **Consequences** (what
it costs, what was rejected). Keep the contract itself in the spec: a record explains a
rule, and the spec is where the rule lives. A decision that is replaced keeps its record,
marked `superseded by NNNN`.
