# Spec: Data model

The runtime contract lives in [`src/model.ts`](../src/model.ts) as zod schemas.
This document is the prose source of truth — change it first, then the schema.

## Faction file (`data/<slug>.yaml`)

```yaml
name: Necrons          # clean display name (from the index page)
slug: necrons          # URL slug; the filename stem
version: "1.0"         # site version stamp, always a quoted string
firstSeen: 2026-06-17  # date this exact content was first observed (see below)
parent: Space Marines  # optional: parent army (sub-factions only; Necrons itself has none — shown for illustration)
detachments:           # 'name' order by default; 'page' (--order page) preserves source order
  - name: Annihilation Legion
    dp: 2              # detachment's "detachment points" cost (integer) or null
    objectives: [PURGE THE FOE] # Force Dispositions granted; always a list, may be empty
    unique: Dynasty   # optional: sub-faction the detachment is restricted to ("UNIQUE: X")
    enhancements:      # 'name' order by default; 'page' preserves source order
      - name: Eldritch Nightmare
        points: 10
      - name: Murdermind
        points: 15
        supportTo:     # optional: units this enhancement unlocks the Support ability for
          - Skorpekh Destroyers
        # leaderTo:    # the Leader-ability counterpart, same shape (whichever the site shows)
units:                 # 'name' order by default; 'page' preserves source order
  - name: Necron Warriors
    pricing:           # tier order preserved (meaningful for per-instance pricing)
      - range: "[1,)"            # interval of unit copies this tier prices (core)
        label: Your Unit Costs   # site heading, kept for reference (secondary)
        costs:                   # source order preserved; not re-sorted
          - { models: 10, points: 80 }
          - { models: 20, points: 190 }
  - name: Technomancer
    pricing:
      - range: "[1,1]"
        label: Your 1st Unit Costs
        costs: [{ models: 1, points: 80 }]
      - range: "[2,)"
        label: Your 2nd + Unit Costs
        costs: [{ models: 1, points: 90 }]
    supportTo: [Immortals, Necron Warriors]  # units it can attach to as Support
    leaderTo: [Lychguard]                    # …and as Leader; a unit may have both
  - name: Redemptor Dreadnought
    groupTitle: Space Marines  # sub-group header this unit sits under (illustrative; see below)
    pricing: [...]
    wargear:                   # per-item costs added on top of the unit's cost
      - { item: Macro plasma incinerator, points: 10 }
```

### `range` — which copies of a repeated unit the tier prices
Interval notation parsed from the tier `label`. `[a,b]` is closed; `[a,)` is unbounded.
| label | range |
|---|---|
| `Your Unit Costs` | `[1,)` |
| `Your 1st Unit Costs` | `[1,1]` |
| `Your 2nd + Unit Costs` | `[2,)` |
| `Your 1st To 2nd Units Cost` | `[1,2]` |
| `Your 3rd + Unit Costs` | `[3,)` |

### `models` / `points` / `desc` — one cost option
`models` is the total model count (sum of quantities in the source row) and `points` the
cost — these are the core values. `desc` is added **only** when the row isn't a plain
"N models" line, so simple rows stay terse and same-count rows stay distinguishable.
`addon: true` marks "+"-prefixed extras (the leading "+ N " is stripped from `desc`).
```yaml
costs:
  - { models: 10, points: 80 }                                              # plain — no desc
  - { models: 3, points: 85, desc: 3 Wolf Guard Headtakers }                # named
  - { models: 6, points: 115, desc: "3 Wolf Guard Headtakers, 3 Hunting Wolves" }  # composite (3+3)
  - { models: 1, points: 60, desc: Invader ATV, addon: true }              # "+ 1 Invader ATV"
  - { models: 1, points: 3500 }                                            # "3,500 pts" (thousands comma)
```

### `leaderTo` / `supportTo` / `wargear` / `groupTitle` — optional unit extras
- `leaderTo` / `supportTo`: the units this unit can join, listed separately per ability
  (from each role block's icon + list). Either may be present, or both, as on
  `Enhancement.leaderTo`/`supportTo` (see
  [0008](../docs/decisions/0008-leader-and-support-lists.md)).
- `wargear`: per-item point costs from the unit's "Wargear Options" block (`per` stripped).
- `legends: true`: marks Legends (deprecated) units — see specs/scraping.md.
- `groupTitle`: the page sub-group the unit is listed under, cased as a name (see
  [Names](#names)) from its army-group header
  (`h3.font-header:not([class*="break-after"])`) — e.g. `Harlequins`/`Ynnari` on
  Aeldari, a Chapter on Space Marines, `Space Marines` for a successor's shared roster.
  Omitted for the base roster (units under the bare UNITS section, with no sub-group header).

### `parent` — parent army (faction-level, optional)
Set when one of the page's unit sub-group headers names **another** known faction (e.g.
`Space Marines` for Black Templars). The units in that group also carry it as their
`groupTitle`; `parent` surfaces the same fact at the faction level. Omitted for top-level
factions, and for non-faction sub-group headers (e.g. `Harlequins`), which live only on the
units. A page can have several sub-groups (Aeldari has `Harlequins` and `Ynnari`); `parent`
is the first that names a faction.

### `unique` (detachment) / `leaderTo` · `supportTo` (enhancement) — optional extras
- `unique`: the sub-faction keyword a detachment is restricted to, from its `UNIQUE: X`
  banner (the `UNIQUE:` prefix stripped, cased as a name). Omitted when absent.
- `leaderTo` / `supportTo`: live on the **enhancement**, not the detachment — the units that
  enhancement unlocks the Leader (resp. Support) ability for, from the `LEADER:`/`SUPPORT:`
  list shown beside it (source order preserved). Buying the enhancement is what grants the
  association, so it is modelled per enhancement. Each omitted when absent.

`parent`, `unique`, `leaderTo` and `supportTo` were all found by the completeness coverage
check (see specs/scraping.md and [0019](../docs/decisions/0019-account-for-every-visible-string.md)).

### `firstSeen` — when this content took effect
The date the file's *current content* was first observed. The scraper keeps it **stable
across no-op scrapes** and only advances it (to the run date) when the rest of the content
actually changes — so it records when each set of values came into effect, and an
unchanged scrape produces no git diff. Implemented in `src/scrape.ts` (`resolveFirstSeen`)
via the content fingerprint `contentKey()` in `src/emit.ts`, which ignores `firstSeen`.

A change to how the scraper writes names (see [Names](#names)) is not new MFM content, so
it must not move `firstSeen` either. For that regeneration, `mfm scrape --ignore-name-case`
compares content with every name upper-cased, as the site writes it (`mapNames()` in
`src/emit.ts` holds the list of name fields). A file whose only difference is the case of
its names keeps its date, and so does `meta.yaml`'s `lastUpdated`. Any other difference
still stamps the run date. Enhancement names are verbatim, so they are compared as they
are.

### Rules
- **One file per faction**; git is the change history
  ([0001](../docs/decisions/0001-git-is-the-change-history.md)).
- **Deterministic ordering** (see `orderContent()` in `src/emit.ts`): top-level keys in a
  fixed order, leaf cost/wargear/enhancement maps rendered in flow style. Entity order
  (units, detachments, enhancements) is selectable via `--order`: `name` (default,
  alphabetical — a points change touches exactly one line) or `page` (source page order,
  faithful to the MFM layout but churns if the site reorders a page).
- **`pricing` is always a list of tiers.** Most units have one tier; units with
  per-instance pricing have several. `range` is the core machine-readable interval;
  `label` is the verbatim site heading kept for humans.
- **`costs` preserve source order** (ascending size). The core is `models`/`points`;
  `desc` is kept only where it adds information (named/composite/add-on rows).
- **Names** follow one rule (see [Names](#names)). Enhancement names and wargear items
  are kept verbatim (already mixed case), and objectives as the site writes them, in
  ALL CAPS (`PURGE THE FOE`).
- **Faithful characters** — the source's typographic apostrophe `’` (U+2019) is preserved
  (e.g. `T’au Empire`), not normalised to `'`.

### Names
The site writes unit, detachment and sub-group names in ALL CAPS. The scraper writes them
in a fixed case that reads like the official names (`nameCase()` in `src/parse/names.ts`;
why, and how it compares with the official names:
[0021](../docs/decisions/0021-names-match-the-official-ones.md)). The rule applies wherever
a name appears: `unit.name`, `groupTitle`, `parent`, the unit and enhancement
`leaderTo`/`supportTo` lists, `detachment.name` and `unique`.
- Each word starts with a capital, and so does each part of a hyphenated word (`-`, or the
  non-breaking `‑` U+2011): `Shield-Captain`, `Ûthar the Destined`. An opening quote or
  bracket (`‘ “ " ' ’ (`) is not part of the word: `‘Iron Hand’ Straken`.
- A letter after an apostrophe inside a word stays lower-case: `Emperor’s Champion`,
  `C’tan Shard of the Deceiver`, `Be’lakor`.
- `a`, `an`, `and`, `at`, `by`, `for`, `from`, `in`, `into`, `of`, `on`, `or`, `the`, `to`
  and `with` stay lower-case, also inside a hyphenated word, unless the name starts with
  one: `Anrakyr the Traveller`, `Voidsmen-at-Arms`, `The Phaeron's Armoury`.
- A short list of words takes the official spelling, which no rule gives
  (`OFFICIAL_SPELLINGS`): `El’Jonson`, and the initialisms `AFV`, `ATVs`, `AX-1-0`, `RSV`,
  `TX42`, `UR-025` and `XV9`. A word matches whatever the style of its apostrophes and
  hyphens, and only its letters change. Add a word only when the official names spell it
  that way.
- Punctuation around a word, opening (`‘ “ " ' ’ (`) or closing (`’ ' ” " ) ] , . ; : ! ?`),
  doesn't hide it from the minor words or the official spellings: `Centaur (RSV)`,
  `Banner of, and for, the Chapter`.
- The rest is the site's own text, characters included (its `’` or `'`, its hyphens). So
  `name.toUpperCase()` gives back the name as the page shows it.

Tier labels are not names: every word of them is capitalised (`Your 1st To 2nd Units
Cost`).

## Meta file (`data/meta.yaml`)

```yaml
schemaVersion: 2          # the files' shape version (see Schema version below); first
version: "1.0"            # site version at last full scrape
lastUpdated: 2026-06-17   # most recent firstSeen across factions (stable on no-op)
notes: |-                 # the expandable "Welcome…" help text, as Markdown
  To muster a Warhammer 40,000 army, you will need the points values for your chosen
  units and **enhancements**, and the Detachment Points (DP) for your chosen **detachments**...

  ## UNITS

  - **Starting Strength**: The number of models a unit contains can affect its points cost...
muster: |-                # the expandable "Muster Armies" army-building rules, as Markdown
  The following rules tell you how to create an army list out of models and units...

  ## SELECT BATTLE SIZE
  ...
  | Battle Size  | Points Total | Detachment Points (DP) | Enhancement Limit | Unit Limit\* |
  | ------------ | ------------ | ---------------------- | ----------------- | ------------ |
  | INCURSION    | 1000         | 2                      | 2                 | 2            |
factions:                 # slugs successfully scraped, sorted
  - adepta-sororitas
  - ...
```
`lastUpdated` deliberately avoids a per-run timestamp so an unchanged scrape leaves
`meta.yaml` byte-identical (no spurious PR). `notes` and `muster` are written on every full
run: a run that can't read them writes no `meta.yaml` at all. Both are **Markdown**:
`rulesPanels()` in `src/parse/panels.ts` decodes each panel from a faction page's RSC
payload and converts it — `<b>` → `**bold**`, all-caps section labels → `##` headings,
`<ul>/<li>` → bullet lists, `<table>` → GFM tables — so the rules keep their structure, and
a change to them (e.g. a battle size's DP) is a readable line diff. See "The rules panels"
in [`scraping.md`](scraping.md).

The runtime contract is the `SiteMeta` schema in `src/model.ts`: `metaFromYaml()` validates
against it, as `factionFromYaml()` validates a faction file against `Faction`.

## Schema version (`schemaVersion`)
`schemaVersion` is an integer saying which shape the files have. It is the first key of
`meta.yaml`, and the first key of `all.json` (see [Releases](#releases)), the one JSON
output. The faction files don't carry it: `meta.yaml` speaks for the dataset it lists.
The current version is `SCHEMA_VERSION` in `src/model.ts`, and `SiteMeta` accepts that
value only, so the data and the code always agree (`mfm check-data` fails otherwise).

| version | shape |
|---|---|
| 1 | before [#41](https://github.com/BSData/wh40k-11e-mfm/pull/41): a unit's `role` and `attachTo`, a detachment's `objective`. No file ever said `1`. |
| 2 | `leaderTo` and `supportTo`, `objectives`, from 2026-09-02. Files written before [#75](https://github.com/BSData/wh40k-11e-mfm/issues/75) have this shape and no `schemaVersion`. |

### Breaking changes
The version goes up by one, in the PR that changes the shape, when a reader of the current
files could break:
- a field or a file is removed or renamed;
- a field's type changes (a string becomes a list, a number becomes nullable), or a
  required field becomes optional;
- a value's meaning changes while its type stays (`points` counted per model instead of
  per unit).

It doesn't go up for an addition: a new optional field, a new file, a new faction. Nor for
the values themselves, which are data rather than shape: points, and also how names are
written (a regeneration like [#88](https://github.com/BSData/wh40k-11e-mfm/pull/88)'s,
which a changelog entry announces).

A bump is announced in three places:
- **the PR body** that makes it, which says "Breaking" and what a reader has to change;
- **the release notes**: the PR adds an entry to the version's changelog file (the
  `change-data-model` skill), which becomes the notes of the release it triggers;
- **Discord**: `mfm announce <before> <after>` with the old and new `data/` names it, and a
  maintainer sends it (`--send`, with `DISCORD_WEBHOOK_URL`), since a model change merges
  through an ordinary PR rather than the scrape workflow.

The reports name it themselves. `mfm diff`, `mfm changelog` and `mfm announce` compare the
two snapshots' `schemaVersion` and name a change right after the count of factions in the
summary line (`` `schemaVersion` 2 → 3 ``, or `— → 2` from a snapshot written before it
existed). To
compare across a bump, `loadMeta()` reads a snapshot's `meta.yaml` as `SnapshotMeta`:
`SiteMeta` with any `schemaVersion`, or none. An unreadable one is an error, not a
snapshot without meta. See
[0028](../docs/decisions/0028-a-schema-version-and-releases-for-consumers.md).

## JSON Schema (`schema/`)
`schema/` holds JSON Schemas (draft 2020-12) generated from the zod model with
`z.toJSONSchema()` (`jsonSchemas()` in `src/schema.ts`):

| file | describes | from |
|---|---|---|
| `faction.schema.json` | a `data/<slug>.yaml` | `Faction` |
| `meta.schema.json` | `data/meta.yaml` | `SiteMeta` |
| `all.schema.json` | `all.json` | `Dataset` |

`pnpm mfm schema` writes them; run it after changing `src/model.ts`. `mfm check-data` fails
while a committed schema differs from the generated one, and on a file in `schema/` that
nothing generates. Each release attaches them. Each schema's `$id` is its file on `main`
(`https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/main/schema/<file>`), and its
`title` and `description` give the `schemaVersion` it describes.

The schemas describe what the model's parser accepts (`io: 'input'`), so they allow keys
they don't list. That is deliberate: data with an optional field added later still
validates against an older schema of the same `schemaVersion`, which is what makes an
addition non-breaking for a reader who validates. The committed files carry no unknown key
all the same: check-data's canonical check catches one. Dates (`firstSeen`,
`lastUpdated`) are strings with a `YYYY-MM-DD` pattern: a YAML parser that returns dates
(see the README) needs them as strings before validating.

## Points table (`data/points.csv`)
Every unit's points as one flat table, for spreadsheets. One row per faction, unit, tier
and cost option, under this header:

```csv
faction,unit,groupTitle,legends,range,label,models,points,desc,addon
necrons,Technomancer,,,"[1,1]",Your 1st Unit Costs,1,80,,
necrons,Technomancer,,,"[2,)",Your 2nd + Unit Costs,1,90,,
```
- `faction` is the slug; the other columns are the fields of the same names (see above).
  An absent field is an empty cell; `legends` and `addon` are `true` or empty.
- RFC 4180 quoting: a cell with a comma, a quote or a line break is quoted, with its quotes
  doubled. So every `range` is quoted (`"[1,)"`). UTF-8, LF line endings, no byte-order
  mark.
- Rows follow the faction files: factions by slug, units in the files' name order
  (same-named units in page order), then each unit's tiers and cost options in source
  order. Points never decide where a row goes, so a points change is a one-line diff.
- Enhancements, wargear and detachment points aren't in it; they stay in the YAML.

`pointsCsv()` in `src/csv.ts` makes it from the faction files in `--out`, and `mfm scrape`
rewrites it at the end of every run, a single faction's included, so it always matches the
files beside it.

## Releases
Each push to `main` that changes `data/` publishes a GitHub release of the dataset, from
`.github/workflows/release.yml`. Before the first one, the data `main` had after each
earlier update is released too, oldest first (see [Past releases](#past-releases)), so the
list reads oldest to newest. A release's parts come from the files, never from the clock:
- **Tag:** `mfm-v<version>+<date>`: `version` from `meta.yaml`, and the last day of the
  newest entry's window in `changelog/v<version>.md` (`## [2026-10-02 → 2026-10-05]` gives
  `mfm-v1.5+2026-10-05`). That is the last day of the update window (see
  [Naming an update](change-tracking.md#naming-an-update)), since the entry is dated by it.
  Two entries can end on the same day (a format change and an update, say), so the second
  entry to end on a day, counted in the file from the oldest, adds `.2`, the third `.3`.
  Hand-written entries count too, released or not. Entries are only ever added on top, so
  an entry's tag never changes. Tags sort by date as text, except that `.10` sorts before
  `.2`.
- **Title:** `MFM v<version> — <window>`, plus the entry's own label when it isn't the
  version (`MFM v1.6 — 2026-10-23: Name casing, schema version, points table and
  releases`).
- **Notes:** that newest entry, with its relative links pointing at the release's commit,
  and a footer giving the `schemaVersion`, a link to the README's "Using the data" and the
  attribution. An entry over GitHub's 125,000-character limit is replaced by a link to the
  file.
- **Assets**, under the same names in every release, so
  `https://github.com/BSData/wh40k-11e-mfm/releases/latest/download/<name>` always serves
  the newest:

  | asset | contents |
  |---|---|
  | `all.json` | `{ "schemaVersion": 2, "meta": <meta.yaml>, "factions": [<every faction file>] }`, factions by slug, keys in the files' order, on one line |
  | `points.csv` | `data/points.csv` |
  | `faction.schema.json`, `meta.schema.json`, `all.schema.json` | the JSON Schemas |
  | `data.zip` | `data/` as the tools write it (each faction file, `meta.yaml`, `points.csv`), under `data/`, dated `lastUpdated`, so the same data zips to the same bytes |

### Past releases
`release/history.json` is a reviewed table of the releases from before releases existed:
one row per update that reached `main`, from the first scrape (v1.0, 2026-06-17) to MFM
v1.6's 2026-10-22 update. Each row gives the tag, the commit on `main` whose `data/` the
release holds, its PR, the version and title, the headings of the changelog entries it
accounts for, whether its data is in schema 1, and any caveat a reader needs. Its notes
are those entries, unless the row has notes of its own: inline (`notes`, for the first
scrape, which no entry describes) or in a file under `release/notes/` (`notesFile`, for
#6, whose 2026-06-22 entry was written later and describes the first scrape; its notes
are the changes #6 made, as `mfm changelog` writes them from the two commits).

A test holds the table to the rules above: each tag and title is what its first entry
gives (v1.4's update and #41's schema change, both of 2026-09-02, are one release, so the
update isn't `.2`), every changelog entry is in exactly one release, the dates only go
up, and every tag is dated before the current release, so no later entry can take one.
The build checks each row against its commit: the commit's `meta.yaml` must give the
row's version, and its `lastUpdated` the tag's date, or the build fails.

A past release is built from `git` (`filesAt()` in `src/ops/git.ts`), so the build needs
the whole history. Its data is brought to the current shape (`snapshotOf()` in
`src/history.ts`): a schema-1 snapshot, from before #41, is converted with #41's mapping
(a unit's `role` and `attachTo` become `leaderTo` or `supportTo`, a detachment's
`objective` becomes `objectives`), which gives MFM v1.3's data exactly as #41 migrated it.
`meta.yaml` gets the current `schemaVersion`. A field the model doesn't know fails the
build rather than being dropped. The assets are then built as for the current release.
The notes end with a **Backfilled** paragraph: the commit and PR it comes from, the date
it was backfilled, and what differs from today's data. That paragraph is worked out from
the data where it can be (the conversion, how many names are cased as before #88, the
fields later scrapes added) and taken from the table's caveats where it can't (Space
Wolves' second Venerable Dreadnought, not yet marked Legends before 2026-10-22). It is the
one part of a release that reads the clock.

### Publishing
`mfm release` (`src/release.ts`) builds every release into a directory, after the same
checks as `mfm check-data`: the table's, oldest first, then the current one. It writes a
plan, `plan.tsv`, of the ones to publish, in order, and prints the whole plan: each tag,
the commit it goes on, its title, whether it is to be latest, its assets with their
SHA-256, and the first lines of its notes. With `--commit`, it asks GitHub which releases
exist (`src/ops/release.ts`):

| a past release (`checkHistorical()`) | |
|---|---|
| not released | published |
| released at its row's commit, with the same asset names | skipped; when the current tools build different bytes (a change to them since), that is reported, as a warning on the run, and the published assets stand |
| released at another commit, or with other assets | the run fails |

| the current release (`checkRelease()`) | |
|---|---|
| not released | published, if the release before it is (below) |
| released at this commit (a re-run) | skipped |
| released at another commit with the same `data/` tree (a dry run, a change outside `data/`) | skipped |
| released at another commit with other `data/` | the run fails |

The last case means `data/` changed without a new changelog entry, and a release is named
by its entry. So a PR that changes `data/` adds one, as update PRs do by themselves and a
regeneration does by hand (see the `change-data-model` skill). The workflow also runs on a
push that changes `changelog/` or `release/`, so the PR that adds a missing entry (or a
row) releases what it describes; one that only edits an entry finds its tag released with
the same data, and publishes nothing.

The release before the current one must be published, or planned in the same run (a row
of the table): `previousRelease()` finds the entry just older than the newest one, across
the version files, and its tag, from its row or by the counting rule. If it isn't
published, the run fails, naming it: its own run failed or was cancelled, and publishing
the current release now would put it after a newer one. The fix is to re-run that run
first, then this one. When no run can publish it (its tag is burnt, see below, or it
reached `main` in the same push as a later entry, so it never had a run of its own), it
goes into `release/unreleased.json`, a reviewed list of entries without a release of their
own, with the reason; the check steps over those.

The workflow has two jobs. `release-assets` runs `mfm release` with the default read-only
token and a full clone, and uploads the result as an artifact; it isn't called `build`,
which is the name of CI's required check. `publish`, the only job that can write, mints the
GitHub App's token for this repository with contents and workflows write (a tag on a commit
whose workflow files differ from `main`'s needs the workflows permission, which the default
token can't have), and runs no code from the repository or its dependencies, only pinned
actions, `gh` and `jq`.
It doesn't take the artifact's word for what to publish. First it checks the whole plan,
before publishing any of it: every tag of the release form, every target a commit, the
past releases rows (tag and commit) of `release/history.json` as committed at the
workflow's commit (read through the API) and in the table's order, and the current
release, if planned, last, under the tag `release-assets` named, for the workflow's
commit. Then it checks that every row the plan leaves out is published already. Only then
does it publish the plan's releases, one at a time, in order, ten seconds apart (the
first run makes twelve, each a create, six uploads and a publish, and GitHub limits how
much content is created per minute), and
stop at the first that fails, so the order can't break. A release an earlier attempt
already published at the same commit is left as it is, so "Re-run failed jobs" carries on
where the run stopped; one published at another commit fails the run. `gh release create
--target <its commit>` uploads the assets to a draft and publishes it once they are all
there. Both jobs start with `harden-runner` in audit mode, like the scrape's. Releases are
immutable on this repository, so a published release, its tag and its assets never
change, and a deleted release's tag can't be used again.

A past release is never marked latest. The current one is, unless a commit on `main`
after its own changed `data/` or `changelog/` (from the compare API, `$COMMIT...main`): an
unrelated merge in the meantime doesn't demote the newest release, and a late re-run of an
older run can't promote older data. A failed call, an answer without a file list, or one
GitHub may have cut short (300 files), is no telling: the release is published not latest,
and the job then fails, so that a re-run, which skips what is published, decides again.
When main has moved on, the job warns and passes: the later run marks its own release.
`publish` runs on every real run, even with nothing to publish, and when the rule says the
current release should be latest and it isn't (it was published while a change to
`changelog/` alone was merging), it marks it latest. It does that with the one field,
`make_latest`, patched on the release by id, since an immutable release takes no other
change. If that fails, or the job can't tell, the error says to re-run the job; marking
the release latest on its page on GitHub is the fallback.

Both jobs have a timeout, so a hung `gh` call doesn't hold the one release queue for
GitHub's six hours: 15 minutes to build, 30 to publish (the first run's twelve releases
take a few minutes). A timeout or a cancel during an upload can leave a draft behind,
which nothing publishes and the next attempt doesn't reuse: list the releases, drafts
included, with `gh release list` (or on the releases page), and delete the draft with
`gh release delete <tag>` before re-running. A draft has no tag yet, so its tag stays
free.

A tag is burnt when a publish fails after GitHub applied it: gh's cleanup deletes what it
takes for a draft, and the tag can't be used again. A burnt current release's entry goes
into `release/unreleased.json`, and a new entry (with the next number, if it is the same
day) releases the data. A burnt past release's row leaves the table for the same list.

Real runs share one concurrency group and run one at a time. GitHub keeps one pending run
per group, so a third push while one runs and another waits cancels the waiting one; the
next run then fails, naming the release that is missing, until the cancelled run is re-run.
A `workflow_dispatch` with `dry-run` builds and prints everything, the checks against
GitHub included, and publishes nothing. So does every pull request that changes `data/`,
`changelog/`, `release/`, `schema/`, `src/`, the dependencies or the workflow: its run
summary shows the releases its merge would publish, and the check fails on the PR, before
the merge, when `data/` changes without a new entry. `publish` runs only for a push or a
dispatch on `main`, and a dry run, a PR or a run on another branch has a concurrency group
of its own, so it can't cancel a real one. See
[0028](../docs/decisions/0028-a-schema-version-and-releases-for-consumers.md).

## Index (in-memory only, not written)
`SiteIndex` = `{ version, factions: [{ slug, name }] }`, parsed from the landing page
to drive the scrape and supply clean display names.

## Integrity of the committed files (`pnpm check-data`)
`data/`, `changelog/` and `DATA-CHANGELOG.md` are generated, so the committed copies must be
exactly what the tools would write. `mfm check-data` (`src/check-data.ts`) fails, naming each file, when:
- a `data/<slug>.yaml` fails the `Faction` schema, isn't named after its `slug`, or isn't
  canonical: reading it with `factionFromYaml()` and writing it back with `factionToYaml()`
  must reproduce it byte for byte, which catches an unknown key, an entry out of order, and
  any other edit that breaks the writer's formatting;
- `data/meta.yaml` fails the `SiteMeta` schema (which includes being at the current
  `schemaVersion`), or `metaToYaml()` doesn't reproduce it;
- `data/meta.yaml`'s `factions` doesn't name exactly the faction files: a slug with no
  `data/<slug>.yaml`, or a faction file whose slug it doesn't list (checked once `meta.yaml`
  passes `SiteMeta`, by file name);
- `data/points.csv` is missing, or isn't what `pointsCsv()` makes of the faction files
  (checked once every faction file passes);
- a file in `schema/` is missing, differs from what `jsonSchemas()` generates, or isn't
  generated at all;
- `DATA-CHANGELOG.md` differs from what `changelogIndex()` generates from `changelog/`.

`pnpm verify` runs lint, typecheck, the tests and then this check. It is the definition of
done, and it is what CI runs. The tests also validate every committed data file against
the committed JSON Schemas with Ajv, an off-the-shelf validator (`test/schema.test.ts`).

A well-formed hand edit, such as one changed points value, is still canonical, so this check
can't tell it from the scraper's output (though a points edit in the YAML alone leaves
`points.csv` behind, which it does catch). Only the scraper writes these files, so CI's
`data-guard` job fails a pull request that changes any of them unless its head branch is an
update branch (`mfm/*`, in this repository) or it carries the `regenerated-data` label,
which a maintainer adds to a PR that reran the scraper, for example to apply a format change.
