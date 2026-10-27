# 0040. A low-risk drift fix merges itself

- **Status:** accepted, for [#113](https://github.com/BSData/wh40k-11e-mfm/issues/113); revises [0024](0024-a-live-smoke-test-reports-and-gates-only-auto-merge.md): the smoke test gates these merges too; and [0029](0029-a-failed-scrape-drafts-its-fix.md): the maintainer no longer reviews, commits the fixture and merges every fix
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
  none of the work for a fix that is low risk, and a person only for one that isn't.

## Decision
A drift fix is sorted into **low risk** or **high risk** by rules that code checks, never
by a model's opinion: the model read the site's pages, which are untrusted, so its view of
its own fix can be steered. A low-risk fix merges itself; a high-risk fix stays a draft,
as now, and asks for the maintainer.

### The page goes in from the artifact
- Before the agent starts, its job copies each page of the `drift` artifact whose name
  isn't already under `test/fixtures/` into `test/fixtures/`, so the agent's tests can
  read it. A page whose name is taken is not copied: the existing fixtures pin older
  pages on purpose (0029, the `add-fixture` skill).
- The agent's patch still may not touch `test/fixtures/`, and "Make the patch" leaves the
  copied pages out of it.
- The PR job downloads the same `drift` artifact and adds, byte for byte, each of those
  new pages that a line the patch adds under `test/` holds as a string, as
  `fixture('orks-legends-cookie.html')` does. A name in a comment doesn't count: #114's
  test named the page it copied markup from, and read another. So every fixture in the PR
  came from the scrape, and none from the model. The agent adds the page's entry to `FIXTURES` in
  `src/fixtures.ts`, as the `add-fixture` skill says.

### The agent knows what checks it
The prompt says that the PR's smoke test scrapes all 30 factions live with its fix, that
the result decides whether the fix merges, and which refreshed pages are now fixtures. The
agent can still send its fix to a person: its note's first line reads exactly `Needs
review:` and why. That can only hold a fix back, so a page that steers the model into
writing it costs a review, not a merge.

### The rules
A fix is low risk when all of these hold. The PR job checks the first five, in
`src/ops/agent-patch.ts`, before it opens the PR; the last two come from the PR's checks.
1. **The agent finished.** A run stopped at its turn or budget limit, or one whose note
   asks for review, is high risk.
2. **Only reading code changed.** Every file the patch touches is one of:
   `src/parse/*.ts`, `src/allowlists.ts`, `src/fixtures.ts`, `specs/scraping.md`,
   `test/parse.test.ts`, or a new file under `docs/decisions/`, and at least one is under
   `src/`: a fix that changes nothing the scrape runs fixes nothing, and gets no smoke
   test. Not a snapshot: vitest loads a snapshot file with `new Function`, so it is code
   that no word list vets. Anything else the patch
   check allows today (`src/ops/`, `src/diff/`, other tests, other specs) is high risk.
3. **No new reach.** No line the patch adds under `src/` or `test/` imports or
   re-exports anything, or names a way out of the parser: `process`, `globalThis`,
   `global`, `require`, `import(`, `eval`, `Function`, `constructor`, `prototype`,
   `__proto__`, `Reflect`, `Proxy`, `fetch`, `WebAssembly`, a quoted `node:`,
   `child_process`. The reason names the word, never the line, which the model wrote.
4. **It is small.** At most 150 lines added or removed, not counting the pages.
5. **The page came from the scrape.** The PR adds at least one fixture, its tests read
   it, and every fixture it adds is a `drift` page, byte for byte, under a name that was
   free. A fix that copies the markup into a test instead, as fixes do today, is high
   risk: `AGENTS.md` wants a saved page to show the markup a parser change handles.
6. **CI passes:** `build` and `data-guard`, which the ruleset on `main` already requires.
7. **The live smoke test passes:** all 30 factions scrape with no failure. Data may come
   out different from the committed `data/`; whether that is right is the fix's and the
   model's call. The difference stays where the smoke test writes it, in its job summary
   on the PR's checks, which the merge comment links: no job that holds a key posts text
   that the fix's code produced. It reaches `data/` only through the next scrape's update
   PR, with its changelog and its *Needs attention* flags, which the maintainer still
   merges.

### What happens
- The PR job decides the risk, records it as a job output, and opens the PR: a draft for
  high risk, ready for review for low risk. It holds the App's key with the scope it has
  now. The commit is signed (`create-pull-request`'s `sign-commits`), so it is verified
  and attributed to the App.
- **Low risk:** a new `merge` job takes over, with the workflow's own token and no App key.
  Like the Dependabot job, it runs `gh` and `jq` and no repository code. It waits until
  every check on the head the PR job pushed has finished, the smoke test among them, then
  squash-merges that head (`--match-head-commit`). After the merge it starts the scrape on `main` (`workflow_dispatch`), whose success closes the
  failure issue as it does now. It then comments on the failure issue, naming the
  maintainer: which PR merged, a link to its smoke test, and that it merged without
  review, to be read when there is time.
- A merge made with the workflow's token starts no push-triggered workflow on `main`, so
  neither `ci.yml` nor `release.yml` runs on the merge commit. That is fine: CI ran on the
  PR, a drift fix changes no `data/`, so no release is due, and the scrape is started
  explicitly.
- If the smoke test or CI fails, or doesn't finish within 45 minutes, or GitHub asks for an
  approval before it merges, the `merge` job turns the PR back into a draft, comments as
  for high risk, and fails red.
- **High risk:** the draft, as now. It comes with a comment, naming the maintainer, that
  lists each rule the fix failed.
- A replay on any branch but `main` never merges and never starts the scrape, so a test
  replay can't publish anything.

## Consequences
- An outage like #113 ends without anyone, in well under an hour from the failed scrape
  to a green one: the agent, CI, the smoke test and the scrape set the time, not when the
  maintainer looks.
- **Code a model wrote after reading the site lands on `main` before anyone reads it.**
  From there it runs in CI, in the scrape's jobs and in `release-assets`, and on every
  machine that runs `pnpm test` before someone has read it. None of those jobs holds the
  App's key (0022). `announce` holds the Discord webhook. The next agent run holds the
  model's key, with its $10 limit. The rules make this hard, not impossible. JavaScript can
  reach `process` by routes no word list catches, so rule 3 is a screen against the plain
  route, not a sandbox. The maintainer accepted this on 2026-10-27, in exchange for not
  reviewing low-risk fixes. The bound is the post-merge comment: a fix that reads wrong
  means reverting it and rotating the model's key.
- A drift that only the factions with fixtures show has no free page name, so its fix is
  high risk under rule 5, and a person adds the page.
- If the site is down while the smoke test runs, the smoke test fails and the fix is held
  for a person, like a Dependabot update.
- The PR job also needs `actions: read`, to download the `drift` artifact. The `merge`
  job holds `contents: write` and `pull-requests: write` (the merge, the draft toggle),
  `actions: write` (start the scrape), `issues: write` (the comment), and `checks: read`
  and `statuses: read` (`gh pr checks`), with the workflow's own token, as
  `dependabot-automerge.yml` does. The App's
  token gains nothing, and isn't held through the wait, which can outlast its hour.
- `main`'s ruleset has `require_extra_approval_for_unattributed_changes` on, a setting
  GitHub doesn't document. If it asks for an approval even on the App's signed commit, no
  fix merges itself, and the `merge` job says so (above). Whether to turn it off is then
  the maintainer's call.

## Not now
- **Update PRs merging themselves.** The data still goes through an update PR that the
  maintainer merges (`review-data-pr`). That is the next step, once the drift fixer has
  earned the confidence.

## Rejected
- **A model judging the risk.** It would read the fix, which a model wrote after reading
  the pages, so the same text could steer the judge. Rules that code checks can't be
  talked to.
- **Requiring the committed data to stay the same.** It would hold every drift that comes
  with a points update, the usual case when GW releases a new MFM. A misread surfaces in
  the update PR, which a person still reads.
- **Making the smoke test a required check.** It would block every PR while the site is
  down. The PR job waits for it instead, for agent fixes only.
- **Putting the page in the patch.** A page is up to about 400 KB of the patch's 512 KB,
  and the PR job would then trust the agent's copy of it. The artifact is the source.
- **Merging with the App's token.** Its merge would run CI and the release on `main`, but
  its scope would grow by `actions: write`, and it expires before the wait for the smoke
  test may end.
- **Posting the data difference in the PR.** The PR job would post text made by code the
  model wrote, a new untrusted input next to the App's key. The smoke test's summary is
  one click away.

## Calls made in the design
The maintainer set the goal (no work for a low-risk fix), let a fix change the data, and
put update PRs merging themselves off for later. These were the writer's calls, for the
maintainer to check:
- the rules themselves: the paths in rule 2, the word list in rule 3, the 150-line limit;
- a low-risk fix must add a page from the scrape; markup copied into a test is high risk;
- the merge runs in a job of its own, with the workflow's token, not the App's;
- the bot's commit is signed;
- the data difference stays in the smoke test's summary;
- a fix whose smoke test or CI fails after it opened goes back to a draft;
- a replay off `main` never merges;
- the agent can ask for review with a `Needs review:` note;
- the rollout replays this outage's run.

## Decided while building it
- **No snapshot** among the low-risk files (rule 2), since vitest runs a snapshot file as
  code. Rule 4 then has nothing to leave out but the pages.
- **A page counts as read only by a quoted name.** On the real outage, #114's patch with
  run 40398589206's `drift` artifact came out low risk under a plain-name match, through
  the comment in its test; it comes out high risk now, "its tests read no page from the
  scrape". The artifact offered 9 free names; the 4 taken ones were left out.
- **The word list** (rule 3) trips, over the 2,479 lines ever added to the low-risk files,
  only on import lines, one comment saying "fetch", and `rsc.ts`'s class `constructor`.
  `node:` counts only quoted, since the parser writes `node: unknown`.
- **The owners come from `.github/CODEOWNERS`**, its `*` line, not a repository
  variable: the file already names them.
- **The merge job merges once the checks pass**, rather than turning on auto-merge: it
  waits for every check anyway, to turn a failed fix back into a draft. It doesn't ask to
  delete the branch: the repository deletes a merged head branch itself.
- **No workflow may write checks or statuses.** The merge trusts a check named `smoke`,
  and code a PR runs could otherwise post one; none does today, and
  `test/workflows.test.ts` now holds every workflow to that.
- **The `diagnose-parse` skill** told the agent to copy markup into a test, which rule 5
  now holds back; its drift-fix section says to read a refreshed page instead.

## Rollout
Build, merge, then close #114 unmerged and replay the outage it was drafted for
(`gh workflow run drift-fix.yml -f run-id=40398589206`). The replay should merge itself,
with `orks-legends-cookie.html` as its page, and the scrape that follows should close
#113. If it doesn't, the outage is fixed by hand from #114.
