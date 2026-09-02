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
     counts, point-change count with ▲/▼ split and net delta, units re-tiered), plus a
     **per-faction table** when two or more factions changed;
   - a **per-faction section** with labelled sub-blocks so it's clear *what* moved and
     *how*: `Units added/removed`, `Unit points` (magnitude-sorted, bold deltas like
     `Necron Warriors — 10 models: 80 → 90 pts (**+10**)`), `Unit pricing re-tiered`
     (see below), `Wargear`, `Unit changes` (role / attachTo), `Detachments
     added/removed`, `Enhancements`, and `Detachment changes` (dp / objective / unique /
     per-enhancement leaderTo);
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

### A re-tiering is a modification, not an add plus a remove
Cost rows are keyed `unit · tier · option`, so when GW changes how a unit is costed —
adding a requisition threshold, so one tier becomes `1st–2nd` / `3rd+` — every key that
unit owns is rewritten. Diffed row by row, one unchanged unit becomes a wall of removals
and additions. In MFM v1.3 eight units picked up a `3rd+` threshold and generated **45 of
the changelog's 70 add/remove lines**, not one of which was an addition or a removal in
any sense a reader cares about; the unit was still there, still doing the same thing,
priced by a new rule.

So the **tier ranges a unit is priced over are its pricing scheme's identity**. When they
differ between snapshots the unit is *re-tiered*: it is kept out of the cost-row diff
entirely and described in one line instead — the tiers before and after, then every
option's old price against its new price in each tier:

    Allarus Custodians — re-tiered [1,) → [1,2] + [3,); 2 models: 110 → 110 / 140 ·
    3 models: 165 → 165 / 195 · 5 models: 275 → 280 / 310 · 6 models: 330 → 340 / 370

Nothing is lost — the genuine 275 → 280 is right there — and the reader is told what
actually happened. It counts as a **changed** unit in the tallies and lands under
**Changed** in `DATA-CHANGELOG.md`. The rule is symmetric, so tiers collapsing back to one
reads the same way. Genuine additions and removals are untouched by this: v1.3's surviving
25 lines are 24 real new Leman Russ wargear options and one real removal.

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

## Announcing an update (Discord)
A merged PR and a changelog file are pull media — someone has to go looking. The
announcement is the push half: one Discord message per MFM update, sent to a channel
webhook.

### Everything but the GitHub calls lives in `src/discord.ts`
No third-party "post to Discord" action: they take *their* inputs (a content string, a
title, a colour) rather than a payload, so one would mean fighting a schema and pinning a
supply-chain dependency in order to render something worse. The hard part — turning two
YAML snapshots into something worth reading — can't be delegated to any of them.

Sending is one HTTP call, which briefly argued for `curl` in the workflow instead of code.
That was wrong, and the tell was concrete: verifying the shell version meant copying it
out of the YAML into a file a test could run, so **the thing verified wasn't the thing
that shipped**. `send()` is therefore in [`src/discord.ts`](../src/discord.ts) next to the
renderer, and [`test/discord.test.ts`](../test/discord.test.ts) drives it against a stub
HTTP server — post, edit, and the fall-back-to-post path all exercised as shipped. It
takes an already-validated base URL for exactly that reason; `webhookUrl()` does the
validation and is tested separately, including the `discord.com.example.invalid`
lookalike.

The workflow keeps only what is genuinely GitHub's: read the marker off the PR, run the
CLI, record a new marker. Roughly ten lines, no branching.

### One message per update, edited as the update grows
The announcement fires when the scrape **detects** the change, not when the PR is
merged — the channel hears about an update the day it lands, not whenever a human gets
round to the review. That puts it on the wrong side of the sticky PR: `mfm/auto-update`
is force-pushed daily, so "an update" is a branch that accretes over days, not an event.

The PR is therefore the message's identity. Its id is kept in a hidden marker inside a
comment on the update PR (`<!-- discord-message-id: … -->`), written with the workflow's
own `GITHUB_TOKEN`, and that marker is the entire state:

| marker on the PR | meaning | announcement |
| --- | --- | --- |
| absent | this update has never been announced | **post**, and record the id |
| present | the update already has a message | **edit** it in place |

So a multi-day update is one Discord message whose contents widen as its window does —
matching the PR title and the `DATA-CHANGELOG.md` entry, which do the same thing. Day
one's thin summary doesn't stay wrong.

The PR is the natural carrier because it lives exactly as long as the update does: once
merged and its branch deleted, the next update opens a fresh PR with no marker and gets a
fresh message. No PAT, no cache, and no state committed to `data/` — which has to stay
byte-reproducible (see *Naming an update*). Deleting the comment forces a repost, which
is the manual escape hatch.

Deciding from the marker rather than from `create-pull-request`'s
`created`/`updated`/`none` output is what makes a failed post **self-healing**: a post
that never landed leaves no marker, so the next run posts rather than assuming yesterday
succeeded. The cost is a PATCH on each run while the PR is open, even when the payload is
unchanged — one request a day, against an update going unannounced because one HTTP call
failed once.

An edit that fails because the message is gone (deleted in Discord, or a stale id) falls
back to posting a new one rather than dropping the announcement.

### What the message says
`announcement()` renders the same `collectChanges()` diff the other renderers use, as a
single Discord embed: the update title, the summary totals, then **every faction that
moved with the number of units and detachments that moved in it**, busiest first, and the
factions a global revision swept up without touching named separately.

Two rankings were tried and rejected on the way to that. Ranking by individual point
delta puts a dozen near-identical variants of one vehicle at the top (v1.3's largest
fourteen swings were almost all Leman Russ turrets). Ranking by a faction's **net** points
is worse than it looks: an update reprices unrelated units, so the deltas cancel — a
faction with eight changes can net zero — and the total is not a quantity anyone plays
with. The question a reader actually has is "how much of my faction moved", and a count
answers it.

The changelog link points at the **PR**, not at `DATA-CHANGELOG.md` on `main`. The
announcement fires when the update is detected, so at that moment `main` still holds the
previous update and a link there is worse than none. The PR body is this update's
changelog and stays correct after the merge.

Discord's embed limits (title 256, description 4096, field value 1024, 6000 total) are
enforced by the renderer, which trims the faction lists rather than letting the API
reject a whole update.

### Failure is not scrape failure
The announce step is `continue-on-error` and no-ops when `DISCORD_WEBHOOK_URL` is unset.
A Discord outage must not fail the scrape job, because that job's `if: failure()` handler
opens a *"scrape failed — the source markup may have drifted"* issue, which would be a
lie. Secret-less runs (forks) simply skip it.

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
3. runs `pnpm scrape --report /tmp/failures.md --dates-from <pr-data>`, then copies the
   freshly scraped `data/` to a third temp dir — the announcement is rendered after the
   PR step, by which point `create-pull-request` has had the working tree,
4. runs `tsx src/diff.ts <old> data --title-file <path>` to produce the changelog body
   and the matching PR title,
5. runs `tsx scripts/update-data-changelog.ts <old> data` to prepend the entry to
   `DATA-CHANGELOG.md`,
6. if `data/` changed, opens (or updates) the sticky PR whose title and body are those
   two outputs — the title also being the commit subject, as `data: <title>` — and which
   commits the updated `DATA-CHANGELOG.md`,
7. reads the Discord marker off the PR, runs `tsx src/discord.ts <old> <new> --send
   --message-id …`, and records a marker comment if that posted a new message (see
   *Announcing an update* above),
8. if the scrape fails, opens an issue whose body includes the per-faction failures file.

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.
