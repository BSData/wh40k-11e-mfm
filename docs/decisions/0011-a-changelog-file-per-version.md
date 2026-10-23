# 0011. A changelog file per MFM version

- **Status:** accepted, [#54](https://github.com/BSData/wh40k-11e-mfm/pull/54)
- **Spec:** [change tracking — The persistent changelog](../../specs/change-tracking.md#the-persistent-changelog-one-file-per-mfm-version)

## Context
The PR body is ephemeral and capped ([0009](0009-fit-the-pr-body-limit.md)), so the
durable, readable record was one `DATA-CHANGELOG.md`, every update prepended. That stopped
scaling: v1.5's entry alone took it from 122 KB to 278 KB, and the file only ever grows.

## Decision
One Markdown file per MFM version under `changelog/` (`changelog/v1.5.md`), each entry the
PR body in full, and `DATA-CHANGELOG.md` regenerated whole as their index. Entries are
dated from the data ([0002](0002-name-and-date-an-update-from-the-data.md)), and written
into a checkout of the PR's base.

## Consequences
A file stays the size of one update, links cleanly from an announcement or a PR, and is
the unit a player asks about ("what changed in v1.5?"). A re-scrape that finds nothing new
leaves both files byte-identical, and re-running on a sticky PR rewrites its entry from the
base's copy rather than stacking a second one. The index is generated, so its header is
edited in the code, not in the file. Entries written before this layout keep their
original Keep a Changelog shape, moved verbatim into their version's file; the
`2026-09-02` schema-change note sits in `v1.4.md`, the version it was made for. A version
usually has one entry: v1.0 has two, because an update landed without GW bumping the
version.
