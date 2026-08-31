# Spec: Change tracking

Goal: surface what changed whenever Games Workshop updates the MFM, with a clean
audit trail. Implemented by [`src/diff.ts`](../src/diff.ts) plus git itself.

## How it works
1. The committed `data/*.yaml` is the **previous** snapshot.
2. The scrape overwrites `data/` with the **current** snapshot.
3. `git diff data/` is the canonical, line-level change history (deterministic YAML
   ordering keeps each change to a minimal diff).
4. `src/diff.ts` renders a **human-readable changelog** by comparing the two snapshots
   (old copy vs. freshly scraped). YAML git diffs bury the signal in long lists, so the
   changelog is built to be scannable:
   - a **title** naming the MFM version and the days it covers — `MFM v1.3 update —
     2026-08-26`, see *Naming an update* below — used verbatim as the `# ` heading, the
     PR title and the commit subject, so a merged update is identifiable from `git log`
     alone;
   - a **summary line** of totals (factions changed, new/removed, unit & detachment
     counts, point-change count with ▲/▼ split and net delta), plus a **per-faction
     table** when two or more factions changed;
   - a **per-faction section** with labelled sub-blocks so it's clear *what* moved and
     *how*: `Units added/removed`, `Unit points` (magnitude-sorted, bold deltas like
     `Necron Warriors — 10 models: 80 → 90 pts (**+10**)`), `Wargear`, `Unit changes`
     (role / attachTo), `Detachments added/removed`, `Enhancements`, and
     `Detachment changes` (dp / objective / unique / per-enhancement leaderTo);
   - whole new / removed factions and version / parent changes are called out too.

   It is **comprehensive**: every field the model carries is diffed, so a change can't
   slip through unreported (the readable counterpart to the parser's coverage guard).

### The table must explain every row
The Units and Detachments columns count entities **added (`+`), removed (`-`) and
changed in place (`~`)**; Points shows the `▲`/`▼` split with the net swing. A routine
MFM update adds and removes nothing — it reprices, re-tiers and edits — so counting only
whole entities left both columns reading `—` on every row, and any faction whose changes
were all re-tiered cost rows or attribute edits showed an all-`—` row above a section
full of changes. The invariant: **a non-empty section is always visible in its row.**
A faction listed purely for a version/parent bump has nothing countable, so it names
that note in its Faction cell, and its section says so rather than sitting empty. But an
MFM revision bumps **every** faction at once, and a note carried by all of them is a
fact about the update, not about any one faction: when it is universal it is stated once
in the summary line (`all v1.2 → v1.3`) and left off the rows entirely. Tagging it onto
only the rows that had nothing else to show would read as "these are the ones that
bumped", which is exactly backwards. The per-faction sections keep their own note either
way, so a section read on its own is still true.

### Folding
Above 50 lines the per-faction detail is wrapped in a `<details>` block, so the title,
summary and table stay on one screen. A full MFM revision runs to hundreds of bullets;
the summary is the thing a reviewer reads first, and the detail is one click away.

## Naming an update
`updateTitle()` names an update `MFM v<version> update — <window>`. The version is the
site-wide one from `meta.yaml` (`loadVersion()`); failing that, the version most
factions carry — they move together, but a page can lag a revision behind, so the
majority is the update's version rather than whichever faction happens to sort first,
and ties go to the higher version so the answer doesn't depend on directory order.

The window is the days. The scrape PR is **sticky**: `mfm/auto-update` is force-pushed
on every run, so an update is not a single day's event. Dates therefore come out of the
data — the `firstSeen` stamps of the factions in the change set — never from "now":
`updateWindow()` takes the earliest and latest of them, and `windowLabel()` renders
`2026-08-31`, or `2026-08-31 → 2026-09-02` once the PR has accumulated changes across
several days.

For that to hold, a re-scrape must not re-stamp what the open PR already captured. The
workflow hands the scrape the PR branch's `data/` via `--dates-from`, and `firstSeen`
resolves to the date of the **oldest** snapshot (committed or PR) whose content matches
what was just scraped. So: a run that finds nothing new reproduces the branch byte for
byte — no force-push, and the PR keeps its start date; a later change stamps only the
factions that moved, widening the window; and a value that reverts to the committed one
resolves back to the committed date instead of looking like a change.

This is pure code — no LLM. An optional LLM polish step could summarise the changelog
into prose later, but is not required.

## `DATA-CHANGELOG.md` (the persistent history)
The PR body is ephemeral; [`DATA-CHANGELOG.md`](../DATA-CHANGELOG.md) is the durable,
accumulating record, in [Keep a Changelog](https://keepachangelog.com) form (newest
first). `changelogEntry()` in `src/diff.ts` renders one dated release block — items
grouped under **Added** / **Changed** / **Removed**, each prefixed by faction and sorted
— headed `## [YYYY-MM-DD] — MFM v<version>`, the date being the same window as the PR
title (so a multi-day update reads `## [2026-08-31 → 2026-09-02]`).
`scripts/update-data-changelog.ts` prepends it just after the `<!-- BEGIN ENTRIES -->`
marker, so every scrape PR also commits the new entry. No changes → the file is left
byte-identical (no spurious diff) — and because the heading is dated from the data
rather than from today, a re-scrape that finds nothing new leaves it byte-identical too.

## Failure reporting
On a parse failure the scrape exits non-zero (no PR) and opens an issue. `src/cli.ts`
collects each faction's located error and, with `--report <path>`, writes
`failuresReport()` (from `src/diff.ts`) — a Markdown block per failed faction with the
exact error (including any unconsumed-content report from the completeness check). The
workflow folds that file into the issue body, so the issue says *which* factions broke
and *why*, not just that something did.

## Workflow integration
The scrape GitHub Action:
1. snapshots the committed `data/` to a temp dir,
2. exports the open update PR's `data/` (if there is one) to a second temp dir,
3. runs `pnpm scrape --report /tmp/failures.md --dates-from <pr-data>`,
4. runs `tsx src/diff.ts <old> data --title-file <path>` to produce the changelog body
   and the matching PR title,
5. runs `tsx scripts/update-data-changelog.ts <old> data` to prepend the entry to
   `DATA-CHANGELOG.md`,
6. if `data/` changed, opens (or updates) the sticky PR whose title and body are those
   two outputs — the title also being the commit subject, as `data: <title>` — and which
   commits the updated `DATA-CHANGELOG.md`,
7. if the scrape fails, opens an issue whose body includes the per-faction failures file.

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.
