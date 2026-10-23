# 0025. Dependabot's minor and patch updates merge themselves

- **Status:** accepted, [#91](https://github.com/BSData/wh40k-11e-mfm/pull/91)
- **Spec:** [change tracking — Dependabot auto-merge](../../specs/change-tracking.md#dependabot-auto-merge)

## Context
Dependabot PRs sat green and unmerged: [#59](https://github.com/BSData/wh40k-11e-mfm/pull/59) from 2026-10-19 on. Merging them also keeps the
repository active, and GitHub disables a public repository's scheduled workflows, the
daily scrape included, after 60 days without activity.

## Decision
`dependabot-automerge.yml` turns on auto-merge for a Dependabot PR, so it merges once the
required `build` check passes, only when every one of these holds; otherwise the PR waits
for a maintainer, with one comment saying why.
- Every dependency is a minor or patch update. This is checked per dependency, because a
  group's own update type is the highest one `dependabot/fetch-metadata` can tell, and it
  passes over a dependency whose type it can't tell.
- Every commit is Dependabot's. fetch-metadata verifies only the first, and auto-merge
  stays on after a push by anyone with write access.
- No workflow file changes. The job runs with the default token, which may not merge
  one, and the App's key can't help: a run Dependabot starts can't read Actions secrets.
- The base's rules require `build`. Auto-merge waits only for required checks, so without
  that rule it would merge an untested update at once.
- When the update changes what the live smoke test covers (the dependencies, in
  practice), that commit's smoke test passed. The job waits for it, up to 25 minutes.
  Auto-merge can't wait for it, because it isn't a required check
  ([0024](0024-a-live-smoke-test-reports-and-never-gates.md)), and a cheerio or Playwright
  update that misreads today's site would otherwise merge and fail the next scrape.

The author check uses the PR's author, not `github.actor`: the actor is whoever caused the
event, and Dependabot can be made the actor on someone else's PR. The job fails closed:
when an update stops qualifying, or a run fails, it turns off the auto-merge an earlier
run turned on. Auto-merge a maintainer turned on, say after reviewing a major update, is
theirs, and stays.

## Consequences
The weekly npm minor and patch group merges itself. The weekly GitHub Actions group
always waits, because it edits the workflows.

The squash commit lands on `main` with the default token, so it starts no workflow of its
own. Its `build` ran against the `main` the PR was based on, and the ruleset doesn't
require a PR to be up to date, so two updates merged the same day land a combination
nothing tested until the next push to `main`.
