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
   - a **summary line** of totals (factions changed, new/removed, unit & detachment `+/-`,
     point-change count with ▲/▼ split and net delta), plus a **per-faction table** when
     two or more factions changed;
   - a **per-faction section** with labelled sub-blocks so it's clear *what* moved and
     *how*: `Units added/removed`, `Unit points` (magnitude-sorted, bold deltas like
     `Necron Warriors — 10 models: 80 → 90 pts (**+10**)`), `Wargear`, `Unit changes`
     (role / attachTo), `Detachments added/removed`, `Enhancements`, and
     `Detachment changes` (dp / objective / unique / per-enhancement leaderTo);
   - whole new / removed factions and version / parent changes are called out too.

   It is **comprehensive**: every field the model carries is diffed, so a change can't
   slip through unreported (the readable counterpart to the parser's coverage guard).

This is pure code — no LLM. An optional LLM polish step could summarise the changelog
into prose later, but is not required.

## `DATA-CHANGELOG.md` (the persistent history)
The PR body is ephemeral; [`DATA-CHANGELOG.md`](../DATA-CHANGELOG.md) is the durable,
accumulating record, in [Keep a Changelog](https://keepachangelog.com) form (newest
first). `changelogEntry()` in `src/diff.ts` renders one dated release block — items
grouped under **Added** / **Changed** / **Removed**, each prefixed by faction and sorted
— headed `## [YYYY-MM-DD] — MFM v<version>`. `scripts/update-data-changelog.ts` prepends
it just after the `<!-- BEGIN ENTRIES -->` marker, so every scrape PR also commits the
new entry. No changes → the file is left byte-identical (no spurious diff).

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
2. runs `pnpm scrape --report /tmp/failures.md`,
3. runs `tsx src/diff.ts <old> data` to produce the changelog (under a dated heading),
4. runs `tsx scripts/update-data-changelog.ts <old> data <date>` to prepend the entry to
   `DATA-CHANGELOG.md`,
5. if `data/` changed, opens a PR whose body is the changelog (and which commits the
   updated `DATA-CHANGELOG.md`),
6. if the scrape fails, opens an issue whose body includes the per-faction failures file.

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.
