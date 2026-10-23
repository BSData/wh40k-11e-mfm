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
And once there are releases, the maintainer wants them to start at the beginning and read
oldest to newest, with the current data the latest.
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
  same day happen (v1.4's update and its schema change, both 2026-09-02), so the second
  one adds `.2`, counted from the file, not from GitHub. Asset names stay the same from one
  release to the next, so `releases/latest/download/all.json` is a stable URL.
- **The past is released too, first, from a reviewed table.** GitHub lists releases in the
  order they are made, so the eleven updates `main` had before releases existed are
  published before the first current release, oldest first, from `release/history.json`:
  each row a commit, a tag, a title and the entries that are its notes. A table rather than
  a walk of `git log`: the rows needed judgement (the baseline has no entry; v1.4's update
  and #41's schema change are one release, so it isn't `.2`), and a reviewer reads the list
  that will be published. Each is built from its commit's `data/`, converted to the current
  shape: the pre-#41 snapshots by #41's own mapping, which a test holds to the data #41
  migrated. The notes say it is backfilled, and what differs from today's data.
- **Never in the wrong order.** One job checks the whole plan, then publishes it one
  release at a time and stops at the first failure, so a later release can't exist without
  the ones before it. A re-run of the failed jobs carries on where it stopped. Across runs,
  the current release is planned only once the one before it is published: a run that
  failed or was cancelled stops the next one, which names it, rather than being skipped
  over. A past release is never latest. The current one is, unless a later commit on
  `main` changed `data/` or `changelog/`: an unrelated merge doesn't demote it, and a late
  re-run of an older run can't promote older data. Every run checks that again, so one
  that published while a changelog-only commit merged gets put right by that commit's run.
- **The write token never meets project code**, as the App key doesn't in the scrape
  ([0022](0022-the-app-key-never-meets-dependency-code.md)). `release-assets` runs `mfm
  release` with a read-only token; `publish` downloads its artifact and runs `gh release
  create`, and is the only job with `contents: write`. A compromised dependency could still
  shape what a real run on `main` publishes, since `release-assets` makes every file, but
  it can't reach the token, push to the repository, or publish from a dry run or another
  branch. Nor can it choose where a release goes, or in what order: a past release must be
  a row of the table as committed, which `publish` reads through the API, in the table's
  order, with every row it leaves out published already, and the current one goes last,
  on the workflow's own commit. This is the second exception to
  [0005](0005-ship-the-code-you-test.md) after the failure report's fallback: a script of
  checks and `gh release create`, kept out of TypeScript so that the token never shares a
  process with the dependencies. A test runs it, as it is, against a stub `gh`. The logic
  before it (the tags, the notes, what to publish) is in `mfm release`, under test. A dry
  run runs `release-assets` as a real run would and skips `publish`, as in the scrape
  ([0023](0023-a-dry-run-publishes-nothing.md)).
- **A preview on every PR that feeds a release.** GitHub dispatches a workflow only once
  its file is on the default branch, so the first `release.yml` couldn't be dry-run before
  it merged; later changes to it can, from their branch. The `pull_request` run of
  `release-assets` needs no dispatch, and on an update or regeneration PR it shows the
  releases the merge would publish, and fails while `data/` changes without a new entry:
  before the merge, where it can still be fixed.

## Consequences
- A data change that lands on `main` without a new changelog entry fails the release: its
  tag is taken, with other data, and a release is immutable. Update PRs always carry an
  entry; a regeneration has to add one by hand. The PR that adds the missing entry
  releases the data, since a change to `changelog/` runs the workflow too.
- A run that finds its tag released with the same `data/` (a dry run, a fix to the
  workflow) publishes nothing and passes, so a dry run stays useful after the first
  release.
- A past release that exists is checked for its commit and its asset names, not its
  bytes. Once the tools change (a new schema description, say), they build other bytes
  for it than were published; failing on that would fail every run from then on, and the
  published release can't change anyway. The difference is reported.
- Every run rebuilds the past releases, which needs the whole history (`fetch-depth: 0`)
  and takes a few seconds. A row's commit must give the row's version and date in its
  `meta.yaml`, or the build fails: a wrong SHA can't become an immutable release.
- A run that fails or is cancelled holds up the next one until it is re-run. That is the
  price of never publishing out of order, and the error says which run to re-run. An
  entry no run can publish (a burnt tag; two entries reaching `main` in one push) is
  listed, with the reason, in `release/unreleased.json`, a reviewed escape hatch.
- When the latest check can't tell (the compare call fails), the release goes out not
  latest and the job fails, so a re-run decides again; it doesn't pass with no release
  marked latest. Correcting latest later patches `make_latest` alone, by the release's id,
  rather than `gh release edit`, which sends the tag name too; the release page is the
  fallback.
- Each job has a timeout (15 and 30 minutes), so a hung upload frees the release queue.
  A cancel or timeout mid-upload can leave a draft, deleted by hand before the re-run.
- #6's 2026-06-22 changelog entry was written later and describes the first scrape, so
  its release takes notes of its own, generated from the two commits, and the entry
  itself is left as it is.
- The backfilled notes give the day they were backfilled, the one thing a release reads
  from the clock.
- Hand-written entries count towards the `.2`, released or not. #88's name-casing note of
  2026-10-23 was never released, so #75 folded its own note into it rather than add a
  second entry that day: the current release is `mfm-v1.6+2026-10-23`, with both as notes.
- A release is immutable from the moment it is published, and so is its tag, even after
  the release is deleted. `gh release create` uploads the assets to a draft and then
  publishes it; if that last request fails after GitHub applied it, gh's cleanup deletes
  what it takes for a draft, and the tag is burnt. It is rare. The way out is to list the
  burnt entry in `release/unreleased.json` (a past release: move its row there), so the
  check for the release before the current one steps over it, and to add a new entry,
  whose tag gets the next number if it is the same day.
- A release is only as fresh as `main`: update PRs wait for review (see the README), so the
  newest values are still on the `mfm/v<version>` branch.
- Faction files carry no `schemaVersion`: a consumer reading a single faction file has to
  read `meta.yaml` too, or use `all.json`.
- Rejected: a strict schema (above); `all.json` without a top-level `schemaVersion` (a
  reader would have to know to look inside `meta`); a third-party release action, which
  would have been one more pinned dependency holding a write token; tagging by merge date,
  which would put a different date on the release than on its notes; numbering same-day
  tags by what GitHub already has, which would make a tag depend on what was released
  before rather than on the file; latest only while the commit is `main`'s head, which an
  unrelated merge during the run would undo.
