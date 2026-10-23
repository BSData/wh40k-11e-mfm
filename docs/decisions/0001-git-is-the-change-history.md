# 0001. Git is the change history

- **Status:** accepted, with the v1.0 baseline; `--order` added in [#10](https://github.com/BSData/wh40k-11e-mfm/pull/10)
- **Spec:** [data model](../../specs/data-model.md#rules), [change tracking](../../specs/change-tracking.md#how-it-works)

## Context
The project has two outputs: the current points, and how they changed. A database or a
hand-kept list of changes would need its own history, review and storage.

## Decision
The committed `data/` is the dataset, and its git history is the change history. Each
scrape overwrites `data/`, and `git diff data/` is the canonical, line-level record of what
moved. Everything about the files serves that diff:
- **One file per faction**, so a change is a small, reviewable diff in one place.
- **Deterministic output.** Top-level keys in a fixed order, leaf maps in flow style, and
  entities sorted by name by default, so a points change touches exactly one line. Page
  order (`--order page`) is faithful to the MFM's layout but churns whenever the site
  reorders a page.
- **No run timestamps.** `firstSeen` advances only when a faction's content changes, and
  `meta.yaml`'s `lastUpdated` is the latest `firstSeen`, so an unchanged scrape leaves every
  file byte-identical and opens no PR.

## Consequences
A YAML diff buries the signal in long lists, so the readable changelog is rendered from
the two snapshots on top of it (`src/diff.ts`), and it is a view of the diff, never a
replacement for it. The files are generated, so nobody edits them by hand.
