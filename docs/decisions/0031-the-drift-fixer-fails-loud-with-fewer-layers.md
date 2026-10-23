# 0031. The drift fixer fails loud, with fewer layers

- **Status:** accepted; revises [0029](0029-a-failed-scrape-drafts-its-fix.md)
- **Spec:** [change tracking — The drift fixer](../../specs/change-tracking.md#the-drift-fixer), and *No dependency cache*

## Context
The first replay of a real drift (#62's footer, on a test branch) ran green and drafted
nothing. Claude Code exited as it started, with "bubblewrap is required for subprocess env
scrubbing and isolation", because the step set `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`. The
step's `continue-on-error`, there so a run cut short at its limits still hands on its
patch, turned that into an empty patch; an empty patch opens nothing, so the run passed.

Looking at why the scrub was there, two of 0029's layers cost more than they bought:
- **The env scrub** was meant to keep the model's key and the token out of the agent's
  commands. Claude Code now needs bubblewrap for it, and installing that takes sudo before
  harden-runner turns sudo off, plus, on Ubuntu 24.04, an AppArmor setting for
  unprivileged user namespaces; none of it has been tried on a runner. Without the sandbox
  the scrub adds nothing: the agent's commands run as the same user as Claude Code and
  can read its environment from `/proc`. 0029 already accepts that the key can leak, with
  its $10 spend limit as the bound.
- **The cache sweep**, a job with `actions: write` and a script of its own, deleted every
  cache entry written while the agent ran, so a poisoned one couldn't reach CodeQL's PR
  runs. The chain it closed takes page text that steers the model into a test that takes
  over a later action for the runtime token, then an entry CodeQL unpacks, and ends in a
  job that only reads the repository and writes code-scanning results.

## Decision
- The agent's step keeps `continue-on-error`, and the job's last step fails the job
  unless the run's record ends with the agent finished, or stopped at its turn or budget
  limit (`error_max_turns`, `error_max_budget_usd`). A run that didn't start, or ended in
  an error, is red; its patch and note are still uploaded to look at, and `pr` doesn't
  run. `test/drift-fix-workflow.test.ts` runs the step's script on each kind of record.
- No `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`.
- No `caches` job: `pr` waits on the agent's job alone.

Kept from 0029: the model's key and the App's key in separate jobs, the patch check, a
draft for a maintainer to review, one run per outage with the turn and budget limits, no
dependency cache in any workflow, the agent's tool list, and harden-runner's egress
block. The block stops a generic exfiltration but not one written for this repository,
since GitHub and the model's API both accept uploads made with an attacker's own
credentials; it costs one list of hosts.

## Consequences
- A drift fixer that can't run says so: the run fails with "The agent didn't run". The
  outage's one run is spent, so a replay (`workflow_dispatch`) is how to try again.
- A cache entry the agent's code writes stays until GitHub evicts it, and a CodeQL PR run
  could restore it. That is accepted as a low-privilege risk; turning off CodeQL's overlay
  analysis closes it.
- If Claude Code's sandbox is wanted later, it comes with bubblewrap installed before
  harden-runner, tried on a runner first. The env scrub alone isn't worth turning back on.
