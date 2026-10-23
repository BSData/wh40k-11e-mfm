# 0028. A schema version, and a release for every data change

- **Status:** accepted, [#75](https://github.com/BSData/wh40k-11e-mfm/issues/75)
- **Spec:** [data model — Schema version](../../specs/data-model.md#schema-version-schemaversion),
  [JSON Schema](../../specs/data-model.md#json-schema-schema),
  [Points table](../../specs/data-model.md#points-table-datapointscsv),
  [Releases](../../specs/data-model.md#releases)

## Context
[#41](https://github.com/BSData/wh40k-11e-mfm/pull/41) renamed `role`, `attachTo` and
`objective`, and said so only inside `changelog/v1.4.md`. At least one public consumer
still has types for the old shape: nothing in the files told it they had changed.
There were no tags or releases either, so consumers listed files through the rate-limited
GitHub API and pinned bare commit SHAs. Spreadsheet users couldn't read nested YAML.

## Decision
- **`schemaVersion`, an integer, starting at 2.** #41 was the first breaking change, so the
  shape before it is 1, though no file ever said so. It is in `meta.yaml` and `all.json`,
  not in each faction file: one place to check, and a faction diff stays about points.
  `SiteMeta` accepts only the current value, so a bump without regenerated data fails
  `check-data`. Nothing catches a breaking change that forgets to bump: that is the first
  step of the `change-data-model` skill, and review's.
- **Bump on what can break a reader**: a removal, a rename, a type change, a field that
  becomes optional, a changed meaning. An addition doesn't bump, and neither does a change
  of values (points, or name casing, which #88 changed without one).
- **Schemas from the zod model, open to unknown keys.** `z.toJSONSchema()` with
  `io: 'input'` describes what the parser accepts. A strict schema
  (`additionalProperties: false`) would make every addition break a reader who validates,
  which contradicts the rule above. Unknown keys in the committed files are caught by
  check-data's round trip instead.
- **A flat CSV of unit points**, made from the faction files by every scrape, rows in the
  files' order, so the YAML's one-line-per-change property carries over.
- **A release per data change on `main`, named by the newest changelog entry.** The tag
  `mfm-v<version>+<last day of the entry's window>` and the notes come from the same
  entry, so they always agree, and nothing is read from the clock. Entries ending on the
  same day are common (v1.4's update and its schema change, v1.6's two notes of
  2026-10-23), so the second one adds `.2`, counted from the file, not from GitHub. Asset
  names stay the same from one release to the next, so `releases/latest/download/all.json`
  is a stable URL.
- **The write token never meets project code**, as the App key doesn't in the scrape
  ([0022](0022-the-app-key-never-meets-dependency-code.md)). `build` runs `mfm release`
  with a read-only token; `publish` downloads its artifact and runs `gh release create`,
  and is the only job with `contents: write`. A compromised dependency could still shape
  what a real run on `main` publishes, since `build` makes every file, but it can't reach
  the token, push to the repository, or publish from a dry run or another branch, and the
  release's commit is the workflow's, not the artifact's. This is the second exception to
  [0005](0005-ship-the-code-you-test.md) after the failure report's fallback: a tag check,
  a "latest" check and one `gh` command, kept out of TypeScript so that the token never
  shares a process with the dependencies. The logic before it (the tag, the notes,
  whether to publish) is in `mfm release`, under test. A dry run runs `build` as a real
  run would and skips `publish`, as in the scrape
  ([0023](0023-a-dry-run-publishes-nothing.md)).
- **A preview on every PR that feeds a release.** GitHub dispatches only workflows that
  exist on the default branch, so a dry run can't try a change to the workflow before it
  merges. A `pull_request` run of `build` can, and on an update or regeneration PR it
  shows the tag and notes the merge would publish, and fails while `data/` changes
  without a new entry: before the merge, where it can still be fixed.

## Consequences
- A data change that lands on `main` without a new changelog entry fails the release: its
  tag is taken, with other data, and a release is immutable. Update PRs always carry an
  entry; a regeneration has to add one by hand. The PR that adds the missing entry
  releases the data, since a change to `changelog/` runs the workflow too.
- A run that finds its tag released with the same `data/` (a dry run, a fix to the
  workflow) publishes nothing and passes, so a dry run stays useful after the first
  release.
- The first release, from #75's own entry, is `mfm-v1.6+2026-10-23.2`: #88's name casing
  note was the first entry of that day, though it was never released.
- A release is only as fresh as `main`: update PRs wait for review (see the README), so the
  newest values are still on the `mfm/v<version>` branch.
- Faction files carry no `schemaVersion`: a consumer reading a single faction file has to
  read `meta.yaml` too, or use `all.json`.
- Rejected: a strict schema (above); `all.json` without a top-level `schemaVersion` (a
  reader would have to know to look inside `meta`); a third-party release action, which
  would have been one more pinned dependency holding a write token; tagging by merge date,
  which would put a different date on the release than on its notes; numbering same-day
  tags by what GitHub already has, which would make a tag depend on what was released
  before rather than on the file.
