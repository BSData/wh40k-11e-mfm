---
name: change-data-model
description: "Use when adding, renaming, removing or reshaping a field in the scraped data (data/*.yaml or data/meta.yaml), for example because the site started showing something new or a single value became a list. Walks the change through specs/data-model.md, src/model.ts, the parser, emit, diff, JSON Schema, tests, the data migration and a changelog note, in that order, so no layer is forgotten."
---

# Change the data model

The shape of `data/` is a public contract: other projects parse it. A change goes through
every layer below, in order. Skipping one fails in a quiet way: a field missing from emit
never reaches the YAML, and one missing from the diff changes without being reported.

Precedent: #41 turned `role` + `attachTo` into `leaderTo` / `supportTo` and `objective`
into `objectives`. Its commit and the `Schema change` entry in
[`changelog/v1.4.md`](../../../changelog/v1.4.md) show the whole path.

## 0. Decide whether it is breaking
Removing, renaming or retyping a field breaks consumers; adding an optional field doesn't.
If `specs/data-model.md` has a breaking-change policy (a `schemaVersion`), follow it. Prefer
one shape for consumers to handle: #41 made `objectives` a list even when there is one.

## 1. Spec: `specs/data-model.md`
Change the prose first: the field in the example YAML, its meaning, when it is present or
omitted, and why it has this shape. If the parser reads something new, also add the selector
to the table in [`specs/scraping.md`](../../../specs/scraping.md). Show the markup in a
fixture before handling it (see the [add-fixture](../add-fixture/SKILL.md) skill).

## 2. Schema: `src/model.ts`
Edit the zod schema, with a doc comment that matches the spec (for `meta.yaml` it is
`SiteMeta`; `grep -rn SiteMeta src` finds it). Optional fields use
`.optional()` and are omitted when absent rather than written as `null` or `[]`, unless the
spec says otherwise (`dp` is nullable, `objectives` is always a list).

## 3. Parser: `src/parse.ts`
Fill the field, and make the completeness check (`assertFactionCovered()`) claim the strings
the new field consumes. Otherwise the check reports them as unconsumed, or a dropped value
goes unnoticed.

## 4. Emit: `src/emit.ts`
`orderUnits()`, `orderDetachments()` and `orderContent()` rebuild every object with a fixed
key order. A field not copied there is silently dropped from the YAML and from
`contentKey()`, so `firstSeen` wouldn't move when only that field changes. Keep the output
deterministic: a one-value change must stay a one-line diff.

## 5. Diff: `src/diff.ts`
Every field the model carries is diffed (see "comprehensive" in
[`specs/change-tracking.md`](../../../specs/change-tracking.md)). Compare the new field in
the changelog and give it a readable line, then describe it in the spec. Check whether
`src/discord.ts` should count it.

## 6. JSON Schema
If the repo has generated JSON Schemas (`schema/*.schema.json`), regenerate them from the
zod model; `pnpm verify` fails when they are stale.

## 7. Tests
- `test/parse.test.ts`: the field parsed from a fixture, with the snapshot diff reviewed
  before `pnpm test -u`.
- `test/emit-diff.test.ts`: the YAML round trip (`factionFromYaml(factionToYaml(f))`), and a
  change to the field producing a changelog line.

## 8. Migrate `data/` in the same PR
If the committed files no longer validate against the new schema, the next update can't read
its "before" snapshot. Reshape them with a throwaway script that reads each file, transforms
it and writes it back through `factionToYaml()`, never by hand; delete the script afterwards.
Then check that `git diff --stat data/` touches only the keys you meant, and that no points,
names or dates moved. Don't do this while an `mfm/*` update PR is open: its branch would
conflict. Label the PR `regenerated-data` so the CI guard on `data/` lets it through.

## 9. Changelog note for consumers
Add a dated `## [YYYY-MM-DD] — Schema change` entry to the current version's
`changelog/v<version>.md`, just below `<!-- BEGIN ENTRIES -->`, like the one in `v1.4.md`:
what changed, why, and what a consumer has to do. This is the one hand edit `changelog/`
takes. `DATA-CHANGELOG.md` lists each file's entry dates, so a new date must appear there
exactly as `changelogIndex()` in `src/changelog.ts` would generate it. Say "Breaking" in
the PR description when it is.

## Done
`pnpm verify` is green, the spec says what the code does, and you have read the snapshot
and `data/` diffs line by line.
