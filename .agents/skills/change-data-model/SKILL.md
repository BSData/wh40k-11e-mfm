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
Follow the policy in "Schema version" in `specs/data-model.md`: a breaking change bumps
`SCHEMA_VERSION` in `src/model.ts` by one, in the same PR, and the PR body says "Breaking"
and what a reader has to change. Prefer one shape for consumers to handle: #41 made
`objectives` a list even when there is one.

## 1. Spec: `specs/data-model.md`
Change the prose first: the field in the example YAML, its meaning, when it is present or
omitted, and why it has this shape. If the parser reads something new, also add the selector
to the table in [`specs/scraping.md`](../../../specs/scraping.md). Show the markup in a
fixture before handling it (see the [add-fixture](../add-fixture/SKILL.md) skill).

## 2. Schema: `src/model.ts`
Edit the zod schema, with a doc comment that matches the spec (for `meta.yaml` it is
`SiteMeta`, in the same file; `metaFromYaml()` validates against it). Optional fields use
`.optional()` and are omitted when absent rather than written as `null` or `[]`, unless the
spec says otherwise (`dp` is nullable, `objectives` is always a list).

## 3. Parser: `src/parse/`
Fill the field (a card's fields are read in `src/parse/cards.ts`), and make the completeness
check (`assertFactionCovered()`) claim the strings the new field consumes. Otherwise the check reports them as unconsumed, or a dropped value
goes unnoticed.

## 4. Emit: `src/emit.ts`
`orderUnits()`, `orderDetachments()` and `orderContent()` rebuild every object with a fixed
key order. A field not copied there is silently dropped from the YAML and from
`contentKey()`, so `firstSeen` wouldn't move when only that field changes. `meta.yaml` goes
through `metaToYaml()`, which lists its keys the same way. Keep the output deterministic: a
one-value change must stay a one-line diff.

## 5. Diff: `src/diff/`
Every field the model carries is diffed (see "comprehensive" in
[`specs/change-tracking.md`](../../../specs/change-tracking.md)). Compare the new field in
`computeChanges()` (`src/diff/collect.ts`) and give it a readable line, then describe it
in the spec. Check whether
`src/discord.ts` should count it. A `meta.yaml` field goes in `collectRules()`, which
compares `version`, `notes` and `muster` and skips `lastUpdated` and `factions` because
they are derived from the faction files; a new field is either compared there or derived
the same way, and the spec says which.

## 6. JSON Schema and the CSV
Regenerate `schema/*.schema.json` from the zod model with `pnpm mfm schema`, and read the
diff; `pnpm verify` fails while they are stale. A unit cost field may belong in
`data/points.csv` too (`POINTS_COLUMNS` in `src/csv.ts`, and its spec section).

## 7. Tests
- `test/parse.test.ts`: the field parsed from a fixture, with the snapshot diff reviewed
  before `pnpm test -u`.
- `test/emit-diff.test.ts`: the YAML round trip (`factionFromYaml(factionToYaml(f))`, or
  `metaFromYaml(metaToYaml(m))` for `meta.yaml`), and a change to the field producing a
  changelog line.

## 8. Migrate `data/` in the same PR
If the committed files no longer validate against the new schema, the next update can't read
its "before" snapshot. Reshape them with a throwaway script that reads each file, transforms
it and writes it back through `factionToYaml()` (`metaToYaml()` for `meta.yaml`), never by
hand; delete the script afterwards. `pnpm check-data` (part of `pnpm verify`) fails on any
file that doesn't validate or isn't in canonical form.
Then check that `git diff --stat data/` touches only the keys you meant, and that no points,
names or dates moved. Don't do this while an `mfm/*` update PR is open: its branch would
conflict. CI's data guard fails a PR that edits `data/`, `changelog/` or `DATA-CHANGELOG.md`
until a maintainer labels it `regenerated-data`, so ask for the label in the PR.

## 9. Changelog note for consumers
Add a dated `## [YYYY-MM-DD] — Schema change` entry to the current version's
`changelog/v<version>.md`, just below `<!-- BEGIN ENTRIES -->` (entries run newest first).
Format it like the one in `v1.4.md`: what changed, why, and what a consumer has to do. This
is the one hand edit `changelog/` takes. `DATA-CHANGELOG.md` lists each file's entry dates,
so regenerate it rather than editing it (`pnpm check-data` fails while it is stale):
```bash
pnpm exec tsx -e "import {readdirSync as r,readFileSync as f,writeFileSync as w} from 'node:fs';import {changelogIndex} from './src/changelog.ts';w('DATA-CHANGELOG.md',changelogIndex(r('changelog').map(n=>({name:n,text:f('changelog/'+n,'utf8')}))))"
```
The entry is not optional when `data/` changes: once the PR merges, the release workflow
names the release after the newest entry and uses it as the notes, and it fails rather
than reuse a tag for other data (see "Releases" in `specs/data-model.md`). Date it the day
you write it; a second entry ending on the same day gets a `.2` tag by itself. Say
"Breaking" in the PR description when it is, and give the `schemaVersion` change in the
entry.

## Done
`pnpm verify` is green, the spec says what the code does, and you have read the snapshot
and `data/` diffs line by line. For a `schemaVersion` bump, also ask a maintainer to send
the Discord announcement after the merge: `pnpm mfm announce <before> <after> --send`, with
the old and new `data/` and `DISCORD_WEBHOOK_URL` set. A model change merges through an
ordinary PR, which the scrape workflow's announcement never sees.
