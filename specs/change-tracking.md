# Spec: Change tracking

Goal: surface what changed whenever Games Workshop updates the MFM, with a clean
audit trail. Implemented by [`src/diff.ts`](../src/diff.ts) plus git itself, with
[`src/discord.ts`](../src/discord.ts), [`src/stack.ts`](../src/stack.ts),
[`src/changelog.ts`](../src/changelog.ts) and [`src/ops/`](../src/ops), run as `mfm`
commands ([`src/bin/mfm.ts`](../src/bin/mfm.ts)). Why each rule below exists is in the
[decision records](../docs/decisions/README.md) it links.

## How it works
1. The committed `data/*.yaml` is the **previous** snapshot.
2. The scrape overwrites `data/` with the **current** snapshot.
3. `git diff data/` is the canonical, line-level change history (deterministic YAML
   ordering keeps each change to a minimal diff). See
   [0001](../docs/decisions/0001-git-is-the-change-history.md).
4. `src/diff.ts` renders a **human-readable changelog** by comparing the two snapshots
   (old copy vs. freshly scraped), built to be scannable:
   - a **title** naming the MFM version and the days it covers — `MFM v1.3 update —
     2026-08-26`, see *Naming an update* below — used verbatim as the `# ` heading, the
     PR title and the commit subject;
   - a **summary line** of totals (factions changed, new/removed, unit & detachment
     counts, point-change count with ▲/▼ split and net delta, units re-tiered), plus a
     **per-faction table** when two or more factions changed;
   - a **per-faction section** with labelled sub-blocks: `Units added/removed`, `Unit
     points` (magnitude-sorted, signed deltas like `Necron Warriors — 10 models: 80 → 90
     (+10)`), `Unit pricing re-tiered` (see below), `Wargear`, `Unit changes`
     (leaderTo / supportTo, a move to or out of Legends, a sub-group change, a tier
     label change), `Detachments added/removed`, `Enhancements`, and
     `Detachment changes` (dp / objectives / unique / per-enhancement leaderTo /
     supportTo);
   - whole new / removed factions, and version / parent / name changes, are called out
     too;
   - a **Rules** section when the rules panels in `meta.yaml` changed (see *The rules
     panels* below).

   A cost option priced per requisition tier names its tier the way the MFM words it —
   `Land Raider — 1 model (3rd+): 240 → 265 (+25)`, with `1st–2nd`, `1st` and `1st+`
   alongside — rather than as the raw `[3,)` interval the data model stores.

   It is **comprehensive**: every field the model carries is diffed, so a change can't
   slip through unreported (the readable counterpart to the parser's coverage guard).
   That includes the fields that aren't points: a unit's `legends` flag (`Necron
   Warriors — moved to Legends`, or `moved out of Legends`), its `groupTitle`
   (`Anathema Psykana Rhino — group: — → Anathema Psykana`), a tier's `label` (`Technomancer — label
   (1st): Your 1st Unit Costs → Your 1st Unit Cost`), and the faction's display name
   (`renamed from Necrons` beside its heading). It covers `meta.yaml` too: the site
   version and the rules panels. A test mutates every field of every schema in turn and
   fails if the changelog stays empty, so a field added to the model later can't be
   forgotten here. Two things are deliberately *not* repeated, because another line
   already states them: a change a sub-faction shares with its parent (see
   *Sub-factions* below), and a Leader/Support target the faction no longer has (next
   paragraph).

   Leader/Support lists on units and enhancements, and detachment Force Dispositions
   (`objectives`), show only membership changes: one nested item per removed (➖) or
   added (➕) name, with unchanged members omitted. If the order of retained members
   also changes, or either list contains repeated names, show the complete before
   and after lists on separate nested lines instead, so no order or occurrence is
   lost. The same formatting is used in the persistent changelog.

   A Leader/Support target the faction **lost** is left out of those lists: `Units
   removed` already says it's gone. A target the faction *gained* stays. A leader whose
   only change was losing such a target is not counted as changed. See
   [0008](../docs/decisions/0008-leader-and-support-lists.md).

### Example from the v1.4 update
Selected lines from the changelog for [PR #42](https://github.com/BSData/wh40k-11e-mfm/pull/42),
rendered with this format (other changes omitted):

```markdown
## Black Templars  _(v1.3 → v1.4)_

**Unit changes:**
- Apothecary — supportTo:
  - ➕ Bladeguard Veteran Squad
- Judiciar — supportTo:
  - ➕ Assault Intercessor Squad
  - ➕ Bladeguard Veteran Squad
  - ➕ Infernus Squad
  - ➕ Intercessor Squad
  - ➕ Sternguard Veteran Squad

## Orks  _(v1.3 → v1.4)_

**Unit changes:**
- Big Mek — leaderTo:
  - ➖ Lootas
  - ➕ Flash Gitz

**Detachment changes:**
- War Horde — objectives:
  - ➕ PURGE THE FOE
```

For an order-only change, the two complete lists would instead appear as:

```markdown
- Technomancer — supportTo:
  - **Before:** Canoptek Wraiths, Immortals, Necron Warriors
  - **After:** Necron Warriors, Immortals, Canoptek Wraiths
```

### Which unit is which
A unit's **identity** is its `groupTitle`, its `name`, and its occurrence index among the
units with the same group and name, in page order. Every comparison uses it: cost rows,
wargear, re-tiering, attribute changes, and the added and removed lists. The units left
unmatched are then paired by name, in page order, and such a pair is a **changed** unit
(`group: A → B`), not a removal plus an addition.

A unit is named as it always was unless another unit in either snapshot has the same
name. Then the report adds its group, `Inquisitor (Every Model Has The Imperium
Keyword)`, and, if the group doesn't tell them apart either, its position: `Venerable
Dreadnought (#2)`. Leader/Support lists hold bare names, so a target counts as lost
only when no unit of that name is left. See [0014](../docs/decisions/0014-unit-identity.md).

### The table must explain every row
The Units and Detachments columns count entities **added (`+`), removed (`-`) and
changed in place (`~`)**; Points shows the `▲`/`▼` split with the net swing. The
invariant: **a non-empty section is always visible in its row.** A faction listed purely
for a version/parent bump has nothing countable, so it names that note in its Faction
cell, and its section says so rather than sitting empty. A note carried by **every**
changed faction is stated once in the summary line (`all v1.2 → v1.3`) and left off the
rows entirely. The per-faction sections keep their own note either way. See
[0004](../docs/decisions/0004-the-table-explains-every-row.md).

### A re-tiering is a modification, not an add plus a remove
The **tier ranges a unit is priced over are its pricing scheme's identity**. When they
differ between snapshots the unit is *re-tiered*: it is kept out of the cost-row diff
entirely and described in one line instead — the tiers before and after, then every
option's old price against its new price in each tier, prices in tier order:

    Allarus Custodians — re-tiered 1st+ → 1st–2nd / 3rd+; 2 models: 110 → 110 / 140 ·
    3 models: 165 → 165 / 195 · 5 models: 275 → 280 / 310 · 6 models: 330 → 340 / 370

It counts as a **changed** unit in the tallies, in its own `Unit pricing re-tiered`
block, never among additions or removals. The rule is symmetric, so tiers collapsing
back to one reads the same way. See [0003](../docs/decisions/0003-a-re-tiering-is-a-change.md).

### Sub-factions: a shared change is listed once
A sub-faction's page (`parent: Space Marines` — Black Templars, Blood Angels, Dark Angels,
Deathwatch, Space Wolves) carries the parent's whole roster. The sections are rendered
per **family** (a parent and the changed factions naming it), with each change listed
once:
- a change a sub-faction shares **verbatim** with its parent (same block, same line) is
  listed only under the parent, whose section says so;
- a change **every** changed sub-faction shares but the parent doesn't is listed once, in
  a `<Parent> sub-factions — shared` section right after the parent's;
- each sub-faction's section lists only what is its own, and opens with how many of
  its changes are listed elsewhere, and where.

This is presentation only: the table and the Discord embed still count every faction's
changes in full. A change two or three sub-factions share, but not all of them, stays in
each of their sections. See [0010](../docs/decisions/0010-sub-factions-share-a-change-once.md).

### The rules panels
`meta.yaml` carries the site version and two rules panels: `notes` (the "Welcome…" text)
and `muster` (Muster Armies: battle sizes, DP, unit limits). `loadMeta()` reads a
snapshot's `meta.yaml`, and every command that compares snapshots (`mfm diff`, `mfm
announce`, `mfm changelog`) passes both snapshots' to the renderers. `lastUpdated` and
`factions` are derived from the faction files, so they aren't compared.

A changed panel is listed in a **Rules** section, ahead of the factions, as a compact
line diff: the changed lines only, `-` before `+`, with `…` between hunks that aren't
adjacent, in a `diff` code block.

````markdown
## Rules

**Muster Armies:**

```diff
- | INCURSION | 1000 | 2 | 2 | 2 |
+ | INCURSION | 1000 | 3 | 2 | 2 |
```
````

A panel that appears or disappears is one line, `**Notes:** removed — it had 12 lines`,
rather than every line of it. The panels count in the summary line as `rules`, with the
same `+`/`-`/`~` marks as units (`**No faction changes** · rules ~1` when nothing else
moved), and the Discord summary names them (`Rules: Muster Armies changed`). They have no
row in the table, which is per faction.

The site version is named in the summary line (`site v1.5 → v1.6`) unless the factions
already say it (`all v1.5 → v1.6`). A rules-only change has no `firstSeen` of its own, so
its window falls back to today, like a removed faction's. See
[0015](../docs/decisions/0015-diff-the-rules-panels.md).

### Order
Wherever the report or the dataset orders names (factions, units, the added and removed
lists, a magnitude tie, the YAML's entity order), it uses one English collator,
`compareNames` in `src/emit.ts`, never the process locale. See
[0016](../docs/decisions/0016-one-english-collation.md).

### Folding
Above 50 lines the per-faction detail is wrapped in a `<details>` block, so the title,
summary and table stay on one screen.

### Fitting GitHub's limit
GitHub caps a PR body at **65,536 characters**. `changelog()` renders the body whole when
it fits. When it doesn't, it replaces faction sections with a one-line stub — **largest
first** — until it fits. A stub keeps its heading and says how many lines it stands in
for; a note under the table names every shortened section. The complete entry is never
shortened: it is the version's changelog file (below), which the same PR commits and the
body names. See [0009](../docs/decisions/0009-fit-the-pr-body-limit.md).

## Naming an update
`updateTitle()` names an update `MFM v<version> update — <window>`. The version is the
site-wide one from `meta.yaml` (`loadVersion()`); failing that, the version most factions
carry, ties going to the higher version.

The window is the days, read from the data, never from "now": `updateWindow()` takes the
earliest and latest `firstSeen` stamps of the factions in the change set (today for one
without a stamp), and `windowLabel()` renders `2026-08-31`, or `2026-08-31 → 2026-09-02`
once the PR has accumulated changes across several days.

A re-scrape must not re-stamp what the open PRs already captured. The workflow hands the
scrape every open update branch's `data/` via `--dates-from`, and `firstSeen` resolves to
the date of the **oldest** snapshot (committed or PR) whose content matches what was just
scraped. So a run that finds nothing new reproduces the branch byte for byte (no
force-push, and the PR keeps its start date), and a later change stamps only the factions
that moved, widening the window. See [0002](../docs/decisions/0002-name-and-date-an-update-from-the-data.md).

This is pure code — no LLM.

## One PR per version, stacked
Each MFM version has its own update branch, `mfm/v<version>`, and a new version stacks on
the open PR instead of overwriting it. `planUpdate()` in [`src/stack.ts`](../src/stack.ts)
(`mfm plan`) decides where the scrape goes, from the open update PRs (label `mfm-update`,
branches `mfm/…` of this repository) and the scraped site version:

| open update PRs | live version | the run writes |
| --- | --- | --- |
| none | v1.6 | a new `mfm/v1.6`, based on `main` |
| top of the stack is `mfm/v1.6` | v1.6 | `mfm/v1.6`, force-pushed on its current base |
| top of the stack is `mfm/v1.5` | v1.6 | a new `mfm/v1.6`, based on `mfm/v1.5`; v1.5's PR is left alone |

The stack is the chain of update PRs from `main` up, each based on the branch of the one
below. The plan fails loud on what it can't place, rather than guessing:
- two update PRs on the same base;
- a live version whose PR sits below the top (the site going back a version);
- a scrape with no site version at all.

A PR is diffed against its **base**, not `main`. The PR body, the version file's entry
and the Discord announcement all compare the base's `data/` with the scrape. The commit
is built on a checkout of the base, so it carries the base's changelog files plus its own
entry.

The workflow links the chain as a GitHub stacked PR (`gh stack link`), best-effort, so it
merges bottom-up. After the bottom PR is squash-merged, the next run finds the next PR
based on `main` and rebuilds it from `main`. See
[0012](../docs/decisions/0012-one-pr-per-version-stacked.md).

## The persistent changelog: one file per MFM version
The durable record is **one Markdown file per MFM version** under
[`changelog/`](../changelog) — `changelog/v1.5.md` — indexed by
[`DATA-CHANGELOG.md`](../DATA-CHANGELOG.md). See
[0011](../docs/decisions/0011-a-changelog-file-per-version.md).

`changelogEntry()` in `src/diff.ts` renders one dated entry, headed
`## [YYYY-MM-DD] — MFM v<version>` — the date being the same window as the PR title, so a
multi-day update reads `## [2026-08-31 → 2026-09-02]` — followed by the same summary
line, table and per-faction sections (at `###`) as the PR body, sub-faction sharing
included, but never folded or shortened. The PR body is this entry under a size limit.

`mfm changelog` writes it:
1. into `changelog/v<version>.md`, just after its `<!-- BEGIN ENTRIES -->` marker —
   creating the file from a short header when the version is new. A second entry for a
   version (an update that lands without GW bumping the version) sits above the first,
   newest first;
2. then regenerates `DATA-CHANGELOG.md` from the directory: one line per version file,
   newest version first (compared numerically, so v1.10 follows v1.9), linking the file
   and listing its entry dates. The index is wholly generated — edit its header in
   `src/changelog.ts`, not the file.

No changes → neither file is touched (no spurious diff), and a re-scrape that finds
nothing new leaves both byte-identical too. Each run writes the entry into a checkout of
the PR's base, so re-running on a sticky PR rewrites its entry rather than stacking a
second one. Entries written before this layout keep their original Keep a Changelog
shape (**Added** / **Changed** / **Removed**).

## Announcing an update (Discord)
One Discord message per MFM update, sent to a channel webhook when the scrape detects the
update. `announcement()` renders it and `send()` posts or edits it, both in
[`src/discord.ts`](../src/discord.ts); `webhookUrl()` validates the webhook (an `https`
`discord.com` or `discordapp.com` `/api/webhooks/` URL) before anything is sent.
`announceOnPr()` in [`src/ops/announce.ts`](../src/ops/announce.ts) adds the GitHub half.
All of it is tested against stub servers. See
[0005](../docs/decisions/0005-ship-the-code-you-test.md).

### One message per update, edited as the update grows
The message's id is kept in a hidden marker inside a comment on the update PR
(`<!-- discord-message-id: … -->`), written with the workflow's own `GITHUB_TOKEN`, and
that marker is the entire state:

| marker on the PR | meaning | announcement |
| --- | --- | --- |
| absent | this update has never been announced | **post**, and record the id |
| present | the update already has a message | **edit** it in place |

The last marker among the comments by the account that writes them wins: the workflow's own
`github-actions[bot]`, or the one `--marker-author` names. A marker anyone else wrote is
ignored, so a comment can't point the next edit at another message. The marker is written only for a message id
that is all digits (a Discord snowflake). The comment also carries the message's
permalink (`https://discord.com/channels/<guild>/<channel>/<message>`), or `link
unavailable` when the webhook won't say where it posts; resolving it is best-effort and
never stops the marker. Deleting the comment forces a repost. Each run edits the message
while the PR is open, even when nothing changed, and a new version's PR, which starts
with no marker, gets a message of its own.

An edit that fails because the message is gone (a 404) falls back to posting a new one.
Any other failed edit (a 429, a 5xx) throws instead, and writes no marker. See
[0006](../docs/decisions/0006-one-discord-message-per-update.md).

### What the message says
`announcement()` renders the same `collectChanges()` diff the other renderers use, as a
single Discord embed: the update title, the summary totals, then **every faction that
moved with the number of units and detachments that moved in it**, busiest first, and the
factions a global revision swept up without touching named separately. It is `null`, and
nothing is posted, when nothing changed.

The changelog link points at the **PR**, not at the version's changelog file on `main`.
Discord's embed limits (title 256, description 4096, field value 1024, 6000 total) are
enforced by the renderer, which trims the faction lists rather than letting the API
reject a whole update. See [0007](../docs/decisions/0007-announce-how-much-moved.md).

### Failure is not scrape failure
The announce step is `continue-on-error` and no-ops when `DISCORD_WEBHOOK_URL` is unset.
A Discord outage must not fail the scrape job, whose failure handler reports that the
source markup may have drifted. Secret-less runs (forks) simply skip it.

## Failure reporting
On a parse failure the scrape exits non-zero (no PR) and opens an issue. `src/scrape.ts`
collects each faction's located error and, with `--report <path>`, writes
`failuresReport()` (from `src/diff.ts`) — a Markdown block per failed faction with the
exact error (including any unconsumed-content report from the completeness check).
`mfm report-failure --details <path>` folds that file into the issue, with a link to the
run's log, so the issue says *which* factions broke and *why*, not just that something
did.

There is one issue per outage, not one per day. A failed run comments on the open
`scrape-failure` issue when there is one (the oldest, if several are), and opens a new
issue only when there isn't. After a successful run, `mfm resolve-failure` comments on
every open one with a link to that run, and closes it. See
[0013](../docs/decisions/0013-one-failure-issue-per-outage.md).

## Workflow integration
Each step that has logic is one `mfm` command, run as `node_modules/.bin/tsx
src/bin/mfm.ts <command>` (not `pnpm exec`, which can print to stdout); a result a later
step reads goes to a file (`--output "$GITHUB_OUTPUT"`, `--body-file`), never through a
captured stdout. The scrape GitHub Action:
1. `mfm open-prs` lists the open update PRs and copies each one's `data/` to its own temp
   dir,
2. runs `pnpm scrape --report /tmp/failures.md` with a `--dates-from` for each of those
   dirs, then copies the freshly scraped `data/` to a temp dir,
3. `mfm plan` plans the PR (its branch, its base, and the PRs below it; see *One PR per
   version, stacked*), and `mfm branch-data` copies the base's `data/` as the "before"
   snapshot,
4. `mfm diff <before> data` writes the changelog body and the matching PR title,
5. checks out the base in a second directory, copies the scraped `data/` into it, and
   runs `mfm changelog <before> data` there. That writes the entry into
   `changelog/v<version>.md` and regenerates the `DATA-CHANGELOG.md` index on top of the
   base's copies,
6. if `data/` changed, opens (or updates) the PR on the planned branch and base. Its
   title and body are the two outputs of step 4, the title is also the commit subject
   (`data: <title>`), and the commit includes the changelog file and the index,
7. when the base isn't `main`, links the chain with `gh stack link` (best-effort),
8. `mfm announce <before> <new> --send --record` posts or edits the Discord message and
   records a new one's marker on the PR (see *Announcing an update* above),
9. if the scrape fails, `mfm report-failure` reports it on the `scrape-failure` issue;
   after a successful run, `mfm resolve-failure` closes any open one.

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.
