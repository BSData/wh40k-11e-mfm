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
    objective: PURGE THE FOE   # objective banner text, or null
    unique: Dynasty   # optional: sub-faction the detachment is restricted to ("UNIQUE: X")
    enhancements:      # 'name' order by default; 'page' preserves source order
      - name: Eldritch Nightmare
        points: 10
      - name: Murdermind
        points: 15
        leaderTo:      # optional: units this enhancement unlocks the Leader ability for
          - Lokhust Destroyers
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
    role: support              # leader | support, if the unit has that ability
    attachTo: [Immortals, Necron Warriors]   # units it can be attached to
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

### `role` / `attachTo` / `wargear` / `groupTitle` — optional unit extras
- `role` (`leader`/`support`) + `attachTo`: present when the unit has the Leader/Support
  ability; `attachTo` lists the units it can join (from the role block's icon + list).
- `wargear`: per-item point costs from the unit's "Wargear Options" block (`per` stripped).
- `legends: true`: marks Legends (deprecated) units — see specs/scraping.md.
- `groupTitle`: the page sub-group the unit is listed under, Title-Cased from its army-group
  header (`h3.font-header:not([class*="break-after"])`) — e.g. `Harlequins`/`Ynnari` on
  Aeldari, a Chapter on Space Marines, `Space Marines` for a successor's shared roster.
  Omitted for the base roster (units under the bare UNITS section, with no sub-group header).

### `parent` — parent army (faction-level, optional)
Set when one of the page's unit sub-group headers names **another** known faction (e.g.
`Space Marines` for Black Templars). The units in that group also carry it as their
`groupTitle`; `parent` surfaces the same fact at the faction level. Omitted for top-level
factions, and for non-faction sub-group headers (e.g. `Harlequins`), which live only on the
units. A page can have several sub-groups (Aeldari has `Harlequins` and `Ynnari`); `parent`
is the first that names a faction.

### `unique` (detachment) / `leaderTo` (enhancement) — optional extras
- `unique`: the sub-faction keyword a detachment is restricted to, from its `UNIQUE: X`
  banner (the `UNIQUE:` prefix stripped, Title-Cased). Omitted when absent.
- `leaderTo`: lives on the **enhancement**, not the detachment — the units that enhancement
  unlocks the Leader ability for, from the `LEADER:` list shown beside it (source order
  preserved). Buying the enhancement is what grants the association, so it is modelled per
  enhancement. Omitted when absent.

`parent`, `unique`, and `leaderTo` were all surfaced by the completeness coverage check in
`src/parse.ts` (see specs/scraping.md) — they were being silently dropped before it forced
them into the model.

### `firstSeen` — when this content took effect
The date the file's *current content* was first observed. The scraper keeps it **stable
across no-op scrapes** and only advances it (to the run date) when the rest of the content
actually changes — so it records when each set of values came into effect, and an
unchanged scrape produces no git diff. Implemented in `src/cli.ts` (`resolveFirstSeen`)
via the content fingerprint `contentKey()` in `src/emit.ts`, which ignores `firstSeen`.

### Rules & rationale
- **One file per faction** — minimal, reviewable diffs; git is the change history.
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
- **Names** (`unit.name`, `detachment.name`, `objective`) are Title-Cased deterministically
  from the source's ALL-CAPS. Enhancement names are kept verbatim (already mixed case).
- **Faithful characters** — the source's typographic apostrophe `’` (U+2019) is preserved
  (e.g. `T’au Empire`), not normalised to `'`.

## Meta file (`data/meta.yaml`)

```yaml
version: "1.0"            # site version at last full scrape
lastUpdated: 2026-06-17   # most recent firstSeen across factions (stable on no-op)
notes: |-                 # the expandable "Welcome…" help text (browser-captured), as Markdown
  To muster a Warhammer 40,000 army, you will need the points values for your chosen
  units and **enhancements**, and the Detachment Points (DP) for your chosen **detachments**...

  ## UNITS

  - **Starting Strength**: The number of models a unit contains can affect its points cost...
factions:                 # slugs successfully scraped, sorted
  - adepta-sororitas
  - ...
```
`lastUpdated` deliberately avoids a per-run timestamp so an unchanged scrape leaves
`meta.yaml` byte-identical (no spurious PR). `notes` is present only on browser runs
(omitted with `--no-legends`). It is **Markdown**: `extractNotesMarkdown` in `src/parse.ts`
converts the rendered notes block — `<b>` → `**bold**`, all-caps section labels → `##`
headings, `<ul>/<li>` → bullet lists — so the help text keeps its structure. `src/browser.ts`
only drives the page (expand + wait) and hands the rendered HTML to that pure function.

## Index (in-memory only, not written)
`SiteIndex` = `{ version, factions: [{ slug, name }] }`, parsed from the landing page
to drive the scrape and supply clean display names.
