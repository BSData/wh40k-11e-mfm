# 0040. A drift fix merges itself once its checks pass

- **Status:** accepted, for [#113](https://github.com/BSData/wh40k-11e-mfm/issues/113); revises [0024](0024-a-live-smoke-test-reports-and-gates-only-auto-merge.md): the smoke test gates these merges too; and [0029](0029-a-failed-scrape-drafts-its-fix.md): the maintainer no longer reviews, commits the fixture and merges every fix, and an outage gets up to three runs
- **Spec:** [change tracking — The drift fixer](../../specs/change-tracking.md#the-drift-fixer), [Live smoke test](../../specs/change-tracking.md#live-smoke-test)

## Context
The site changed its enhancement markup on 2026-10-26 and nine factions stopped parsing
([#113](https://github.com/BSData/wh40k-11e-mfm/issues/113)). Four minutes after the
failure issue, the drift fixer had drafted [#114](https://github.com/BSData/wh40k-11e-mfm/pull/114),
and its CI went green. The fix was right: the PR's live smoke test scraped all 30 factions with it, with no
failure, and got exactly the committed `data/`. Then it waited for the maintainer, as
0029 has every fix do, and the scrape stayed red. Three things in the process made the
wait look necessary when it wasn't:
- **The page.** The fix needs the refreshed page as a fixture. The agent can't commit one:
  its job can't reach the site, a page is too big to write through edits, and a page the
  model wrote would be made-up evidence, so the patch check refuses `test/fixtures/`. But
  the page already exists, byte for byte as the site served it: the failed scrape saved
  it in its `drift` artifact, in a job that runs no model.
- **The live check.** The agent wrote "I didn't run any live scrape, so the other eight
  factions are untested". It can't; its job blocks the site. The PR's smoke test ran one
  anyway, minutes later, and nothing connects the two: the prompt doesn't tell the agent,
  and the PR body's checklist doesn't name the result.
- **The review.** Every fix waits for a person, whatever it touches. The maintainer wants
  the repository to run by itself, and a person only when the agent asks for one.

What a bad fix can do here is bounded: the releases are immutable, the model's key has a
$10 spend limit, and the tokens that write can't force-push or rewrite `main`. For a data
tracker whose worst case is a revert, the maintainer chose autonomy over caution
(2026-10-27).

## Decision
A drift fix merges itself once CI and the live smoke test pass: those are the checks that
test what it does. Code decides the rest, never a model's opinion, since the model read
the site's pages, which are untrusted. Only the agent can hold a fix for a person, by
asking or by not finishing. A fix whose checks fail is closed, and the outage gets another
run, up to three.

### The page goes in from the artifact
- Before the agent starts, its job copies each page of the `drift` artifact whose name
  isn't already under `test/fixtures/` into `test/fixtures/`, so the agent's tests can
  read it. A page whose name is taken is not copied: the existing fixtures pin older
  pages on purpose (0029, the `add-fixture` skill).
- The agent's patch still may not touch `test/fixtures/`, and "Make the patch" leaves the
  copied pages out of it.
- The PR job downloads the same `drift` artifact and adds, byte for byte, each of those
  new pages that a line the patch adds holds as a string, as
  `fixture('orks-legends-cookie.html')` and its entry in `FIXTURES` do. A name in a comment
  doesn't count: #114's test named the page it copied markup from, and read another. So
  every fixture in the PR came from the scrape, and none from the model.

### The agent knows what checks it
The prompt says that the PR's smoke test scrapes all 30 factions live with its fix, that
the result decides whether the fix merges, and which refreshed pages are now fixtures. The
agent can send its fix to a person: its note's first line reads exactly `Needs review:`
and why. That can only hold a fix back, so a page that steers the model into writing it
costs a review, not a merge.

### The rules
A fix merges itself when all of these hold. The PR job checks the first two, in
`src/ops/agent-patch.ts`, before it opens the PR; the last two come from the PR's checks.
1. **The agent finished, and didn't ask for review.** A run stopped at its turn or budget
   limit, or one whose note starts with `Needs review:`, waits for a person.
2. **It changes something under `src/`.** The scrape runs nothing else, and the smoke
   test runs only for a change there.
3. **CI passes:** `build` and `data-guard`, which the ruleset on `main` already requires.
4. **The live smoke test passes:** all 30 factions scrape with no failure. Data may come
   out different from the committed `data/`; whether that is right is the fix's and the
   model's call. The difference stays where the smoke test writes it, in its job summary
   on the PR's checks, which the merge comment links: no job that holds a key posts text
   that the fix's code produced. It reaches `data/` only through the next scrape's update
   PR, with its changelog and its *Needs attention* flags, which the maintainer still
   merges.

Where a fix may reach is the patch check's, as before: regular files under `src/`,
`specs/`, `test/` (not `test/fixtures/`) and `docs/decisions/`, nothing that looks like a
credential, at most 512 KB and 40 files. That keeps every fix away from the workflows,
the dependencies and `data/`. Inside those paths anything goes, snapshots included.

### What happens
- The PR job decides the risk, records it as a job output, and opens the PR: a draft for
  high risk, ready for review for low risk. It holds the App's key with the scope it has
  now. The commit is signed (`create-pull-request`'s `sign-commits`), so it is verified
  and attributed to the App.
- **Low risk:** a new `merge` job takes over, with the workflow's own token. Like the
  Dependabot job, it runs `gh` and `jq` and no repository code. It waits until
  every check on the head the PR job pushed has finished, the smoke test among them, then
  squash-merges that head (`--match-head-commit`). After the merge it starts the scrape on
  `main` (`workflow_dispatch`) with the App's token (see *After it shipped*), whose
  success closes the failure issue as it does now. It
  then comments on the failure issue, naming the maintainer: which PR merged, a link to
  its smoke test, and that it merged without review, to be read when there is time.
- **A check fails,** or the checks don't finish within 45 minutes: the `merge` job closes
  the PR, starts the scrape again, says so on the failure issue, and fails red. If the
  scrape still fails, the gate gives the outage its next run, from `main` and the newest
  pages. Reopening the closed PR is how a person takes it over instead.
- **GitHub refuses the merge** (an approval the ruleset asks for): the PR goes back to a
  draft and waits for a person, since another run would meet the same refusal.
- **Up to three runs per outage.** The gate counts the runs recorded on the failure
  issue. A fix that merged but left the scrape failing gets the next run too, so a drift
  that comes in steps is fixed in steps. Three runs at the usual $1–2 is about $6 of the
  key's $10, and the key's limit is the hard stop.
- **High risk:** the draft, with a comment naming the maintainer and why. An open draft
  holds the outage's other runs until a person closes or merges it.
- A merge made with the workflow's token starts no push-triggered workflow on `main`, so
  neither `ci.yml` nor `release.yml` runs on the merge commit. That is fine: CI ran on the
  PR, a drift fix changes no `data/`, so no release is due, and the scrape is started
  explicitly.
- A replay on any branch but `main` never merges and never starts the scrape, so a test
  replay can't publish anything.

## Consequences
- An outage like #113 ends without anyone, in well under an hour from the failed scrape
  to a green one: the agent, CI, the smoke test and the scrape set the time, not when the
  maintainer looks. A flaky check or a miss costs another run, not a person's time.
- **Code a model wrote after reading the site lands on `main` before anyone reads it,**
  with no screen on what it says. From there it runs in CI, in the scrape's jobs and in
  `release-assets`, on every machine that runs `pnpm test`, and in the next agent run,
  which holds the model's key. None of those jobs holds the App's key (0022); `announce`
  holds the Discord webhook. The maintainer accepted this on 2026-10-27, for the bounds
  above. The post-merge comment is how someone reads it later: a fix that reads wrong means
  reverting it and rotating the model's key.
- A drift that only factions with fixtures show has no free page name, so its fix comes
  with no page; it still merges, on the smoke test's word, with the markup in its test.
- If the site is down while the smoke test runs, the smoke test fails and the PR is
  closed. The scrape started then fails as an outage, with no `drift` artifact, so no run
  starts; the next scheduled scrape that fails on drift gets the next run.
- Nobody had yet seen whether a failed scrape that the `merge` job's token started
  starts this workflow. GitHub's docs say a `workflow_dispatch` from that token starts a
  run, and say nothing about the `workflow_run` its end raises. It starts none, so the
  `merge` job now starts the scrape with the App's token (*After it shipped*).
- The PR job also needs `actions: read`, to download the `drift` artifact. The `merge`
  job holds `contents: write` and `pull-requests: write` (the merge, the close, the draft
  toggle), `issues: write` (the comment), and `checks: read` and `statuses: read` (`gh pr
  checks`), with the workflow's own token, as `dependabot-automerge.yml` does. It starts
  the scrape with an App token that holds `actions: write` alone, minted after the wait,
  which can outlast a token's hour.
- `main`'s ruleset has `require_extra_approval_for_unattributed_changes` on, a setting
  GitHub doesn't document. If it asks for an approval even on the App's signed commit, no
  fix merges itself, and the `merge` job says so (above). Whether to turn it off is then
  the maintainer's call.

## Not now
- **Update PRs merging themselves.** The data still goes through an update PR that the
  maintainer merges (`review-data-pr`). That is the next step, once the drift fixer has
  earned the confidence.
- **Telling the next run why the last one failed.** It starts fresh from `main` and the
  newest pages. A run that read the failed checks would do better, for the work of
  bringing their logs into the agent's job.

## Rejected
- **A model judging the risk.** It would read the fix, which a model wrote after reading
  the pages, so the same text could steer the judge. Rules that code checks can't be
  talked to.
- **Rules on what the fix says:** a list of the files a fix may touch, a word screen on
  imports and `process`, at most 150 lines, a page from the scrape that the tests read.
  The first build had them. They held back fixes the checks would have passed, a word
  screen is no sandbox, and what they guarded against is bounded already. The maintainer
  chose autonomy over them.
- **Leaving a fix whose checks failed as a draft.** It holds every later run until a
  person looks, so one flaky smoke test would stop the repository.
- **Requiring the committed data to stay the same.** It would hold every drift that comes
  with a points update, the usual case when GW releases a new MFM. A misread surfaces in
  the update PR, which a person still reads.
- **Making the smoke test a required check.** It would block every PR while the site is
  down. The PR job waits for it instead, for agent fixes only.
- **Putting the page in the patch.** A page is up to about 400 KB of the patch's 512 KB,
  and the PR job would then trust the agent's copy of it. The artifact is the source.
- **Merging with the App's token.** Its merge would run CI and the release on `main`, but
  its scope would grow by `actions: write`, and it expires before the wait for the smoke
  test may end. The scrape is now started with an App token after all, one minted after
  the wait with `actions: write` alone (*After it shipped*); the merge still isn't.
- **Posting the data difference in the PR.** The PR job would post text made by code the
  model wrote, a new untrusted input next to the App's key. The smoke test's summary is
  one click away.

## Calls made in the design
The maintainer set the goal (the repository runs by itself, and a person steps in when
the agent asks), let a fix change the data, put update PRs merging themselves off for
later, and chose autonomy over caution. These were the writer's calls, for the
maintainer to check:
- three runs per outage;
- a fix whose checks fail is closed, and one GitHub refuses to merge goes back to a draft;
- a fix must change something under `src/`, and an unfinished run waits for a person;
- the merge runs in a job of its own, with the workflow's token, not the App's;
- the bot's commit is signed;
- the data difference stays in the smoke test's summary;
- a replay off `main` never merges;
- the agent can ask for review with a `Needs review:` note;
- the rollout replays this outage's run.

## Decided while building it
- **A page counts by a quoted name** in a line the patch adds. On the real outage, #114's
  test named a page in a comment and read another; a plain-name match would have added
  the page nothing reads. The artifact offered 9 free names; the 4 taken ones were left
  out.
- **The owners come from `.github/CODEOWNERS`**, its `*` line, not a repository
  variable: the file already names them.
- **The merge job merges once the checks pass**, rather than turning on auto-merge: it
  waits for every check anyway, to close a failed fix. It doesn't ask to delete the
  branch: the repository deletes a merged head branch itself.
- **No workflow may write checks or statuses.** The merge trusts a check named `smoke`,
  and code a PR runs could otherwise post one; none does today, and
  `test/workflows.test.ts` now holds every workflow to that, a job left to the
  repository's default token, which can write, included. The merge also asks for the
  smoke check of the `Live smoke test` workflow, which a status or a check run made
  through the API doesn't carry.
- **The merge job merges nothing without a head**, since an empty
  `--match-head-commit` pins nothing, and the head comes from an action Dependabot bumps.
  It waits for `build` and `data-guard` to be listed as well as the smoke test, so a
  merge never runs ahead of the required checks and fails for it.
- **The `diagnose-parse` skill** told the agent to copy markup into a test; its
  drift-fix section says to read a refreshed page instead.
- **Loosened before it shipped.** The first build also held a fix for a file outside the
  parser, an import or a global, more than 150 lines, or no page its tests read, and left
  a failed fix as a draft with one run per outage. The maintainer read it on 2026-10-27
  and asked for autonomy over caution: those rules went, and the retry came in.

## Rollout
Build, merge, then close #114 unmerged and replay the outage it was drafted for
(`gh workflow run drift-fix.yml -f run-id=40398589206`). The replay should merge itself,
and the scrape that follows should close #113. If it doesn't, the outage is fixed by hand
from #114.

It went that way on 2026-10-27, after #115 merged. The maintainer had closed #113 and
#114 already, so the replay recorded its run on no issue. It drafted
[#116](https://github.com/BSData/wh40k-11e-mfm/pull/116) in 20 turns for $0.19, with the
refreshed `orks-legends-cookie.html` from the artifact. CI and the smoke test (30 of 30
factions) passed, and it merged itself five minutes after the replay started. The
scrape it started then passed, with the data unchanged, so no update PR followed.

## After it shipped
That scrape also settled what *Consequences* had left open: GitHub raises no `workflow_run`
for a run the workflow's own token started. A scheduled scrape's drift-fix run starts 2–3
seconds after it ends; none started after this one. So the scrape the `merge` job starts,
after a merge or after closing a fix, would never start the outage's next run if it
failed: the next scheduled scrape would, up to a day later.

The `merge` job now starts the scrape with the App's token instead. Events made with it
start workflows, as the update PRs' CI shows, so the scrape's end should raise
`workflow_run`, and the gate decide as it does for a scheduled scrape: the three-run limit
and the failure issue apply unchanged. That part is not yet seen; the next scrape the
`merge` job starts will show it. The token is minted with `actions: write` alone, in a
step after the wait, so the wait can't outlast it, and only the step that starts the
scrape uses it. The job's own token loses `actions: write`. The App's key now reaches a job
that runs no repository code and installs no package, only pinned actions, `gh` and `jq`,
as 0022 asks.

Rejected: having the `merge` job wait for the scrape and start the drift fixer itself. A
`workflow_dispatch` from the workflow's token does start a run, but the gate treats every
dispatch as a maintainer's replay, which skips the run limit, so the gate would need a way
to tell the bot's dispatch from a person's, and the job would wait minutes more.
