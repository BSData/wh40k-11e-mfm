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
name. Then the report adds its group, `Inquisitor (Every Model Has the Imperium
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
`factions` are derived from the faction files, so they aren't compared. A change of
`schemaVersion` is the summary line's first clause after the count of factions, in the
reports and the Discord summary alike: a bump breaks readers of the files (see
[Schema version](data-model.md#schema-version-schemaversion)).

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

### Needs attention
Some changes are more likely the scraper misreading the site than GW changing it.
`collectAttention()` in [`src/diff/attention.ts`](../src/diff/attention.ts) flags them:

| flag | when |
| --- | --- |
| a faction is gone | a faction in the old snapshot isn't in the new one, or the site's index (`meta.yaml`'s `factions`) no longer lists it |
| a faction lost more than half its units | more than half of the units it had (by identity, see *Which unit is which*) aren't in the new snapshot, whether or not new ones were added: a misread name looks like that too |
| only the version changed | the site or the factions moved to a new version, and nothing else changed: no faction content and no rules panel |
| a value dropped to 0 | a cost option, wargear item or enhancement went from more than 0 to 0 |
| a value changed threefold | it went to at least three times what it was, or to a third of it or less, or up from 0 |

The scraper writes a file for each faction the index lists and deletes none, so a
faction the index stops listing keeps its old file, unchanged, and the diff never sees it
go: the index is where it shows. Its flag says the file was kept.

A re-tiered unit's prices aren't in the cost diff, so they are checked option by option,
against the range of the option's old prices: a new price above the old highest is
measured from that highest, and one below the old lowest from that lowest, by the value
rules above. So it is flagged at three times the old highest or more (any price at all
above an old highest of 0), and at a third of the old lowest or less, 0 included.

The PR body lists the flags in a **Needs attention** warning (a GitHub `> [!WARNING]`
alert), straight after the title and before everything else, one line each: the faction
in bold, then what moved, as `**Orks**: Nobz — 5 models: 100 → 350 (×3.5)`. A value's
flag that several factions share word for word (a sub-faction carrying its parent's
roster) is one line naming them all. At most 50 lines are listed, then how many more
there are, which `mfm attention <before> <after>` lists in full. The warning is part of
the body's head, so fitting GitHub's limit never cuts it. A flag alone makes a body,
and a Discord message: a faction gone from the index changes no data file, so without it
the body would say `No changes detected.` and nothing would be announced. Such an update
has no changelog entry either (`mfm changelog` writes none), so its body's blurb says
the PR commits none, and that `meta.yaml` is the whole change. The warning isn't in the
changelog file: it is for the reviewer, and every other change it names is in the entry
anyway.

The Discord message says how many lines there are. When there are any, the workflow
labels the update PR `needs-attention`, creating the label if the repository has none,
and a later run that finds none takes the label off. Taking it off by hand doesn't stick
while the flags are there: the next run puts it back. A flag never fails the run or
blocks the merge: the reviewer checks the line against the site. See
[0027](../docs/decisions/0027-flag-what-looks-like-a-misread.md).

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

The last marker among the comments by the account that writes them wins: the workflow's
own `github-actions[bot]`, or the one `--marker-author` names. A marker anyone else wrote
is ignored, so a comment can't point the next edit at another message. The marker is
written only for a message id that is all digits (a Discord snowflake). The comment also
carries the message's permalink (`https://discord.com/channels/<guild>/<channel>/<message>`),
or `link unavailable` when the webhook won't say where it posts; resolving it is
best-effort and never stops the marker. Deleting the comment forces a repost. Each run
edits the message while the PR is open, even when nothing changed, and a new version's PR,
which starts with no marker, gets a message of its own.

An edit that fails because the message is gone (a 404) falls back to posting a new one.
Any other failed edit (a 429, a 5xx) throws instead, and writes no marker. See
[0006](../docs/decisions/0006-one-discord-message-per-update.md).

### What the message says
`announcement()` renders the same `collectChanges()` diff the other renderers use, as a
single Discord embed: the update title, the summary totals, then **every faction that
moved with the number of units and detachments that moved in it**, busiest first, and the
factions a global revision swept up without touching named separately. When some changes
need attention (see *Needs attention*), the summary opens with how many. It is `null`, and
nothing is posted, when nothing changed and nothing needs attention.

The changelog link points at the **PR**, not at the version's changelog file on `main`.
Discord's embed limits (title 256, description 4096, field value 1024, 6000 total) are
enforced by the renderer, which trims the faction lists rather than letting the API
reject a whole update. See [0007](../docs/decisions/0007-announce-how-much-moved.md).

### Failure is not scrape failure
The announce step is `continue-on-error` and no-ops when `DISCORD_WEBHOOK_URL` is unset.
A Discord outage must not fail the `announce` job, because `report` reports a failed job
as a scrape that failed, and says the source markup may have drifted. Secret-less runs
(forks) simply skip it.

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

A failure in any job, a job that timed out included, is reported by the `report` job (see
*Workflow integration*). When that job fails before `mfm` can report (in its checkout or
setup, or in the report step itself), a fallback step that needs only `gh` files the
failure the same way: the issue then links the run and says there is no per-faction
detail. So a failure is reported unless the run itself was cancelled, or GitHub can't be
reached.

A failed scrape also leaves the drift fixer (below) the pages that show why, when the
report names a failure the parser could have caused: the `drift` artifact.

## The drift fixer
When the site changes its markup, the fix takes judgment: find what moved, change the
parser or an allowlist, update the spec. `drift-fix.yml` has a model draft it as a draft
PR for a maintainer to review; everything around the model is plain Actions, and each
part holds only what it needs. See
[0029](../docs/decisions/0029-a-failed-scrape-drafts-its-fix.md).

1. **The failure artifact**, in `scrape` (no secrets, no model). When the scrape fails,
   `mfm refresh-fixtures --failed /tmp/failures.md --out /tmp/drift/fixtures` downloads,
   over HTTP, the pages that show why: each failed faction's fixtures, or its page as the
   scrape fetches it (`<slug>-legends-cookie.html`) when no fixture covers it, and
   `necrons-panels-rsc.html` for the rules panels. A failed fetch is an outage, not drift
   (`isFetchFailure()` in `src/fetch.ts`), so it gets nothing, and neither does a run with
   no report. Nothing is saved unless every page downloads. The pages and the report are
   uploaded as the `drift` artifact (`drift-dry-run` from a dry run); with nothing saved
   there is none. This is the drift fixer's only access to the site.
2. **The gate** (`mfm drift-fix-gate`, `src/ops/drift-fix.ts`). `drift-fix.yml` runs on
   every `Scrape MFM` run on `main` that fails (`workflow_run`), and on
   `workflow_dispatch` with the id of a failed run to replay, one run at a time (its own
   concurrency group). The agent runs only when:
   - the run is this repository's `scrape.yml`, on the branch the workflow runs on, and
     it failed;
   - it has an unexpired `drift` artifact (a replay also takes `drift-dry-run`);
   - no open PR is labelled `agent-fix`;
   - for a failed scrape, not a replay: there is an open `scrape-failure` issue, and it
     records no drift-fix run yet. A record counts only in a comment by
     `github-actions[bot]` that starts with it.

   The gate records the run it lets through on that issue
   (`<!-- drift-fix-run: <run id> -->`, with the command to replay it) before the agent
   starts, so an outage gets one agent run however long it lasts, even when that run
   fails.
3. **The agent** (job `agent`) holds the model's key, the repository secret
   `ANTHROPIC_API_KEY`, and no other secret. Its token has `contents: read` and
   `actions: read`, the checkout keeps no credentials, and harden-runner blocks egress
   except to the model's API, GitHub (`github.com`, `api.github.com` and its release
   downloads), the npm registry and `nodejs.org`, with sudo and containers off;
   harden-runner itself always allows GitHub's Actions service and its storage.
   The dependencies, and Claude Code from npm (`npm ci`, with the version and integrity
   hashes pinned by `.github/drift-fix/package-lock.json`), are installed before
   the agent starts. `anthropics/claude-code-action` runs Claude Sonnet 5.5 once, for at
   most 30 turns, 20 minutes and $2 (`--max-budget-usd`). Its tools are Read, Edit, Glob and Grep, and Bash for
   exactly `pnpm verify`, `git diff` and `git diff --stat`: no web tools and no Write.
   Its commands run with the model's key and the token scrubbed from their environment.
   The prompt points at the `diagnose-parse` skill (its section "In the drift-fix
   workflow") and hands it the artifact as untrusted data; never an issue, a comment or a
   PR. The job uploads what the agent changed as a patch (`git diff`, with the new files
   under the allowed paths), with the agent's closing note, the run's turns and cost, and
   whether it finished; a run cut short by its limits still hands on what it changed, and
   its draft says so. The run's full record stays in the job. Since `pnpm verify` runs
   tests the model wrote, the rest of this job is within its reach; see *No dependency
   cache*.
4. **The caches** (job `caches`, `actions: write`) runs after the agent, however it ended,
   and deletes every Actions cache entry created since the gate finished (see *No
   dependency cache*). `src/ops/cache-sweep.ts`, which imports only Node's own modules and
   runs under plain Node, lists the entries newest first by creation, page by page until
   one older than that, deletes them, and goes round again until a pass finds none, so a
   flood of later entries can't push one off the list. An entry it can't delete fails the
   job.
5. **The PR** (job `pr`) runs only once `caches` has succeeded: the draft PR starts a
   CodeQL run, which restores from main's cache. It holds the App's key and no model
   credential. Like `publish`, it
   runs pinned actions and `gh`, plus one repository file: `src/ops/agent-patch.ts`, under
   plain Node, which imports only Node's own modules (a test checks), so no dependency
   code meets the key. The script rejects the whole patch unless:
   - it reads exactly as `git diff` writes a patch, every line where `git apply` expects
     it, so the two can't disagree about which files it touches;
   - every file in it is a regular file (mode `100644`: no links, submodules, mode
     changes, copies or binary changes) under `src/`, `specs/`, `test/` or
     `docs/decisions/`, and not under `test/fixtures/`, since a saved page is a download
     and the maintainer commits the refreshed one; a rename counts at both ends;
   - nothing it adds, and nothing in the agent's note, looks like a credential.

   It applies the patch to a fresh checkout of the commit the agent worked on, and checks
   that the tree changed exactly there. Then the App's token, scoped as in `publish`,
   opens a draft PR from `agent-fix/scrape-<run id>` to the branch the workflow ran on,
   labelled `agent-fix` (the label is created if missing), so CI runs on it, and the
   default token links it from the failure issue. The body names the scrape run, the
   files, the agent's note in a code block (where nothing in it renders), the run's turns
   and cost, and what is left to do, and stays under GitHub's 65,536-character limit
   (the note is cut to fit). An empty patch opens nothing.
6. **A maintainer** reviews it, commits the refreshed page that shows the drift as the
   fixture, and merges. The next successful scrape closes the failure issue, as always.

The model is the cheaper tier on purpose: Claude Sonnet 5.5 costs $2 per million input
tokens and $10 per million output tokens. A run is expected to cost $1–2 of the key's $10
spend limit. Claude Code stops at the turn that takes it past $2, so the worst case is $2
and that last turn: about $3 with the context cached, at most about $5 for a turn that
re-read a near-million-token context uncached. The PR body and the run's summary say what
each run cost.

To replay a failure: `gh workflow run drift-fix.yml -f run-id=<run id>`. With
`--ref <branch>`, it replays a failed scrape run on that branch (a dry run's will do) and
the draft PR targets that branch, which is how a change to the drift fixer is tried out
before it reaches `main`.

## Workflow integration
Each step that has logic is one `mfm` command, run as `node_modules/.bin/tsx
src/bin/mfm.ts <command>` (not `pnpm exec`, which can print to stdout); a result a later
step reads goes to a file (`--output "$GITHUB_OUTPUT"`, `--body-file`), never through a
captured stdout. The scrape workflow (`scrape.yml`) runs four jobs, one after another:

1. **`scrape`**, with no secrets and a token that only reads:
   1. `mfm open-prs` lists the open update PRs and copies each one's `data/` to its own
      temp dir,
   2. runs `pnpm scrape --report /tmp/failures.md` with a `--dates-from` for each of
      those dirs,
   3. `mfm plan` plans the PR (its branch, its base, and the PRs below it; see *One PR per
      version, stacked*), and `mfm branch-data` copies the base's `data/` as the "before"
      snapshot,
   4. `mfm diff <before> data` writes the changelog body and the matching PR title,
   5. checks out the base in a second directory, copies the scraped `data/` into it, and
      runs `mfm changelog <before> data` there. That writes the entry into
      `changelog/v<version>.md` and regenerates the `DATA-CHANGELOG.md` index on top of
      the base's copies,
   6. uploads the staged files, both snapshots and the body as the `update` artifact,
      and gives the plan, the title and the base's commit as job outputs. A failed
      scrape uploads its failure report instead, as `failure-report`, and, when the parser
      could have caused it, the `drift` artifact for the drift fixer (see *The drift
      fixer*).
2. **`publish`** holds the App's key, and runs no repository code (see *The App token*).
   It first checks what `scrape` handed over, since that job ran every dependency: the
   branch is an update branch (`mfm/v…`), the base is `main` or another one, the base
   commit is on the base branch, and the staged files are regular files named
   `data/*.yaml`, `changelog/v*.md` and `DATA-CHANGELOG.md`, and nothing else. Then it
   checks out the base's commit afresh, replaces its `data/`, `changelog/` and
   `DATA-CHANGELOG.md` with the staged ones, and, if anything changed, opens (or
   updates) the PR on the planned branch and base. Its title and body are the two
   outputs of `mfm diff`, and the title is also the commit subject (`data: <title>`).
3. **`announce`**, when there is a PR: when the base isn't `main`, links the chain with
   `gh stack link` (best-effort); `mfm attention <before> <new> --label --pr-number <n>`
   puts the `needs-attention` label on the PR or takes it off (see *Needs attention*);
   and `mfm announce <before> <new> --send --record` posts or edits the Discord message
   and records a new one's marker on the PR (see *Announcing an update* above). The
   label and the announcement are `continue-on-error`: neither is a scrape failure.
4. **`report`**: if any job failed or timed out, `mfm report-failure` reports it on the
   `scrape-failure` issue (with the failure report, when there is one), and if that step
   didn't succeed, a fallback step reports it with `gh` alone. After a successful run,
   `mfm resolve-failure` closes any open one.

Every job starts with `step-security/harden-runner` in audit mode: it records the job's
outbound connections and processes, and blocks nothing. The drift fixer's agent is the
exception: it blocks.

### No dependency cache
No workflow restores or saves an Actions cache. A workflow run on `main` writes cache
entries that every later run on `main`, and every PR, restores, and a cache entry is an
archive that is unpacked at whatever paths it names. The drift fixer's agent job is such
a run, and `pnpm verify` there runs tests a model wrote, which can reach the job's later
steps and the Actions runtime token they get, and harden-runner always lets a job reach
GitHub's Actions service and its storage. So:
- `pnpm/setup` runs with `cache: false` and `cache-dependency-path:
  .github/no-dependency-cache`, a file that never exists, in every job. `cache: false`
  alone still restores and saves pnpm's lockfile-verification log, keyed on the
  lockfile's hash; with no lockfile to hash, there is no key, and neither cache is
  touched. Each job installs from the registry, which costs it a few seconds.
- `setup-node` runs with `package-manager-cache: false`, and no workflow uses
  `actions/cache`.
- The drift fixer's `caches` job deletes every cache entry created since its gate, since
  the agent's code can still write one, before its draft PR opens.

`test/workflows.test.ts` holds every workflow to the first two; it can't see a cache a
third-party action keeps inside itself, so a pinned action's own caching is checked when
it is pinned (claude-code-action v1.0.251 runs `setup-bun` with `no-cache: true`).

What is left is CodeQL's default setup, which the workflows don't configure: its PR runs
restore `codeql-overlay-base-database-*` from main's cache and unpack it with `tar -P`,
at the absolute paths it names. A poisoned entry would run code in a CodeQL job, which
holds `security-events: write` and reads the repository: a low-privilege execution risk,
not a way to the keys. It is open from the agent's first `pnpm verify` to the end of the
sweep, up to about half an hour, and longer if the agent's code sent the runtime token
out, since that token can stay valid for about six hours. Turning off CodeQL's overlay
analysis closes it. See
[0029](../docs/decisions/0029-a-failed-scrape-drafts-its-fix.md).

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.

### The App token
The update PR is opened with a token from the project's GitHub App, `bsdata-automaton`,
so that its push starts CI like anyone else's: events made with a workflow's
`GITHUB_TOKEN` start no workflows. In `publish`, `actions/create-github-app-token` mints
it from the org variable `BSDATA_AUTOMATON_APP_CLIENT_ID` and the org secret
`BSDATA_AUTOMATON_APP_PRIVATE_KEY`, scoped to this repository, with `contents: write` and
`pull-requests: write`, and only `create-pull-request` uses it. The release workflow's
`publish` mints its own, with `contents: write` and `workflows: write`, for `gh release
create` alone (see "Publishing" in `specs/data-model.md`). Every other job uses its own
`GITHUB_TOKEN`, with only the permissions it needs; so do the stack link and the Discord
marker, which needn't start anything.

The key never shares a job with dependency code: `publish` runs pinned actions, a file
copy and the checks above, nothing else. It takes no `.git` from the artifact, because git
config can run commands and `create-pull-request` runs git there. See
[0022](../docs/decisions/0022-the-app-key-never-meets-dependency-code.md). The drift
fixer's `pr` job mints the same token the same way, for its draft PR, and holds to the same
rule (see *The drift fixer*).

### Dry run
`gh workflow run scrape.yml --ref <branch> -f dry-run=true` runs `scrape` as a real run
would, and skips `publish`, `announce` and `report`. So it opens no PR, links no stack,
posts no Discord message or marker, and neither opens, comments on nor closes a failure
issue; a failed dry run is reported by its red run alone. `scrape` puts what a real run
would have published in the run's summary instead: the plan, the title, the files the
commit would change, and the PR body. The Discord payload goes to the log, from `mfm
announce` without `--send`, which makes no request. A separate `app-check` job mints the
App's token, unused, so a dry run also checks the App's credentials and permissions.
A dry run has its own concurrency group. A failed dry run's drift artifact is named
`drift-dry-run`, which only a replay of the drift fixer takes. See
[0023](../docs/decisions/0023-a-dry-run-publishes-nothing.md).

## Around the pipeline
### Live smoke test
`smoke.yml` runs on each PR that touches `src/`, the dependencies (`package.json`,
`pnpm-lock.yaml`, `pnpm-workspace.yaml`), `.node-version` or `smoke.yml` itself. It
scrapes the live site with the PR's code into `$RUNNER_TEMP`, with `--dates-from data` so
a faction that matches its committed file keeps its date, and puts the `mfm diff`
changelog from the committed `data/` to that scrape in the job summary, with a notice
when they differ. A difference never fails the job; a scrape that fails does, with its
failure report in the summary. It is not a required check, but Dependabot auto-merge
waits for it (below). The job has `contents: read` and no secrets, so a PR from a fork
runs it the same way. See
[0024](../docs/decisions/0024-a-live-smoke-test-reports-and-gates-only-auto-merge.md).

### Dependabot auto-merge
`dependabot-automerge.yml` runs on each PR whose author (not `github.actor`) is
Dependabot, and reads the update with `dependabot/fetch-metadata`. It turns on
auto-merge (`gh pr merge --auto --squash`), which merges once the required `build`
check passes, only when all of these hold:
- every dependency in it is a minor or patch update, checked per dependency;
- every commit in it is Dependabot's;
- it changes no workflow file, which the job's `GITHUB_TOKEN` may not merge;
- the rules of the PR's base require `build`;
- when it changes a path the smoke test runs on, this commit's smoke test, run in this
  repository, passed. The job waits for it, up to 45 minutes.

Each run starts by turning off the auto-merge an earlier run of this job turned on, and
only a merge decision turns it on again, for the commit that was checked. A run for an
older commit than the PR's head does nothing. Otherwise the PR waits for a maintainer,
with one comment saying why. Auto-merge a maintainer turned on is left alone. See
[0025](../docs/decisions/0025-dependabot-minor-and-patch-updates-merge-themselves.md).
