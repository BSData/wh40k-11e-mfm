# 0022. A schema version, and a release for every data change

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
  `SiteMeta` accepts only the current value, so a model change that forgets to bump, or a
  bump that forgets to regenerate, fails `check-data`.
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
  entry, so they always agree, and nothing is read from the clock. Asset names stay the
  same from one release to the next, so `releases/latest/download/all.json` is a stable
  URL.
- **The job that can write runs no project code.** `build` runs `mfm release` with a
  read-only token; `publish` downloads its artifact and runs `gh release create`, and is
  the only job with `contents: write`. A compromised dependency can't create or alter a
  release. This is the second exception to [0005](0005-ship-the-code-you-test.md) after the
  failure report's fallback: one `gh` command, kept out of TypeScript so that the token
  never shares a process with the dependencies. The logic around it (the tag, the notes,
  whether to publish) is in `mfm release`, under test.

## Consequences
- A data change that lands on `main` without a new changelog entry fails the release, since
  its tag is taken and a release is immutable. Update PRs always carry an entry; a
  regeneration has to add one by hand. A second update merged on the same day as the first,
  for the same version and with the same window end, would hit the same wall; it hasn't
  happened, and the fix would be a suffix on the tag.
- A release is only as fresh as `main`: update PRs wait for review (see the README), so the
  newest values are still on the `mfm/v<version>` branch.
- Faction files carry no `schemaVersion`: a consumer reading a single faction file has to
  read `meta.yaml` too, or use `all.json`.
- Rejected: a strict schema (above); `all.json` without a top-level `schemaVersion` (a
  reader would have to know to look inside `meta`); a third-party release action, which
  would have been one more pinned dependency holding a write token; tagging by merge date,
  which would put a different date on the release than on its notes.
