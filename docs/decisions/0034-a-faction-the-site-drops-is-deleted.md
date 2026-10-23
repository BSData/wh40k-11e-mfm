# 0034. A faction the site drops is deleted from the data

- **Status:** accepted, for [#89](https://github.com/BSData/wh40k-11e-mfm/issues/89); decides what [0027](0027-flag-what-looks-like-a-misread.md) left for later
- **Spec:** [scraping — The rules panels](../../specs/scraping.md#the-rules-panels-over-http), [change tracking — Needs attention](../../specs/change-tracking.md#needs-attention)

## Context
The scraper wrote a file for each faction the index listed and deleted none. A faction the
site stopped listing kept its old file in `data/`, unchanged, while the full run's
`meta.yaml` left its slug out of `factions`. Only the index flag of
[0027](0027-flag-what-looks-like-a-misread.md) showed it, as "its `data/` file is kept as it
was", and the rest of the update was blind to it:
- The dataset contradicted itself. `points.csv` is made from every faction file, and a
  release from every file in `data/`, so `all.json`, `points.csv` and `data.zip` would carry
  the stale faction while `all.json`'s own `meta.factions` omitted it.
- `mfm changelog` writes no entry for a change to `meta.yaml`'s list alone, and a `data/`
  change with no new entry fails the release, on the PR's preview and after the merge
  ([0028](0028-a-schema-version-and-releases-for-consumers.md)), until someone writes an
  entry by hand.
- `check-data` now fails when `meta.yaml`'s `factions` and the faction files disagree, so
  the update PR's required `build` check would go red. The bot's branch can't be fixed by
  hand: the next run force-pushes it. It would stay red until the code changed.

No faction has left the index yet: all 12 revisions of `data/meta.yaml` list the same 30
slugs.

## Decision
When a full run writes `meta.yaml`, it also deletes each faction file in `--out` whose name
isn't a slug the index lists, and logs it. A `*.yaml` other than `meta.yaml` that doesn't
read as a faction (`--out .` holds `pnpm-lock.yaml`) is not deleted: the run fails, naming
the file. The slugs come from the index, not from the factions scraped: a listed faction
that failed keeps its old file, and the run exits 1, so no update PR is made from it. A `--faction` run, and a full run whose
rules panels failed, write no `meta.yaml` and delete nothing.

The diff then reports the faction as removed, in the PR body and the changelog entry, as:

```text
🗑 **Removed faction**: the site no longer lists it, so `data/<slug>.yaml` is deleted; earlier releases keep it
```

## Consequences
In the release after the merge, the faction is gone from `meta.yaml`'s `factions`, from
`all.json`, `points.csv` and `data.zip`, and
`raw.githubusercontent.com/…/main/data/<slug>.yaml` returns 404 instead of stale data. Its
release notes (the changelog entry) carry a section saying it was removed and its file
deleted. Earlier releases, tags and commit-pinned URLs keep the file. Consumers who iterate
`meta.factions`, as the README shows, see nothing change but a faction leaving. The files
keep their shape, so `schemaVersion` doesn't move.

A misread index now opens a PR that deletes files. It is caught the way every misread is:
the removed faction is flagged as gone in **Needs attention**, a human reviews the PR, and
nothing merges an update PR but the maintainer. Rejected: a cap on deletions per run, which
a real withdrawal of several factions would trip, and which the review already covers.

A slug GW renames reads as one faction removed and one added, with the old file deleted and
the new one written.

0027's index flag stays, for a snapshot that keeps a file its own `meta.yaml` no longer
lists. Since this decision only a failed run leaves one, and `check-data` rejects it.
