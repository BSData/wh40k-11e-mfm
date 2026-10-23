# 0016. One English collation

- **Status:** accepted, [#86](https://github.com/BSData/wh40k-11e-mfm/pull/86)
- **Spec:** [change tracking — Order](../../specs/change-tracking.md#order)

## Context
Names were sorted with `localeCompare` and no locale, which uses the process's. Under a
POSIX locale that put Orks' `Big’Ed Bossbunka` before `Big Mek`, so the same data came out
in a different order on a differently configured machine, and the dataset's order is part
of its byte-reproducibility ([0001](0001-git-is-the-change-history.md)).

## Decision
Everything that orders names, in the dataset and in the reports, uses one English collator:
`compareNames` in `src/emit.ts`.

## Consequences
The committed files were already in English order, so nothing in `data/` moved. A new sort
uses `compareNames`, never a bare `localeCompare` or `.sort()`.
