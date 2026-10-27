# 0029. A failed scrape drafts its own fix, with the model's key and the App's key in separate jobs

- **Status:** accepted, for [#77](https://github.com/BSData/wh40k-11e-mfm/issues/77); revised by [0031](0031-the-drift-fixer-fails-loud-with-fewer-layers.md): no env scrub and no cache sweep, and a run that can't start fails; by [0032](0032-one-claude-code-pin.md): the action installs Claude Code itself; and by [0040](0040-a-drift-fix-merges-itself.md): a fix merges itself once its checks pass, with the scrape's page
- **Spec:** [change tracking — The drift fixer](../../specs/change-tracking.md#the-drift-fixer)

## Context
The scrape failed on 2026-10-21 and 2026-10-22 ([#60](https://github.com/BSData/wh40k-11e-mfm/issues/60), [#61](https://github.com/BSData/wh40k-11e-mfm/issues/61)) because the site added a
footer, and stayed broken until the maintainer fixed it in [#62](https://github.com/BSData/wh40k-11e-mfm/pull/62). That fix took judgment:
refresh the page, find what moved, choose between dropping the footer and allowlisting its
strings, update the spec and re-baseline. Everything around the judgment is mechanical.

A model can make the judgment, but three things make it risky to run one in CI:
- **Its input is untrusted.** It reads the site's pages and the failure report, which
  quotes them. Text on a page can tell a model what to do.
- **It runs code.** Its fix has to pass `pnpm verify`, which runs the tests it edits, so
  anything the job holds, the model's key included, is within reach of what it writes.
- **The keys reach far.** The model's key, the repository secret `ANTHROPIC_API_KEY`, has
  a $10 spend limit; the App's key can write to every repository the App is installed on
  ([0022](0022-the-app-key-never-meets-dependency-code.md)).

## Decision
`drift-fix.yml` drafts the fix as a draft PR, in jobs split by what each holds:
- The failed scrape, which already reaches the site and holds no secret, saves the pages
  that show the failure (`mfm refresh-fixtures --failed`) with the report, as the `drift`
  artifact. It saves nothing for a failed fetch, which is an outage.
- A gate decides from GitHub's records alone: a failed run of this repository's scrape
  with a drift artifact, no open `agent-fix` PR, and one agent run per outage, recorded on
  the `scrape-failure` issue before the agent starts.
- The agent's job holds the model's key and a token that only reads. harden-runner
  blocks every host but the model's API, GitHub and the package downloads the setup
  needs, everything is installed before the agent starts, and the agent's tools are file
  reads and edits, `pnpm verify` and `git diff`. Its prompt points at the `diagnose-parse`
  skill and hands it the artifact as untrusted data, never issue or PR text. What it
  changed leaves as a patch.
- The PR job holds the App's key and no model. It checks the patch with one repository
  file that imports only Node's own modules, so no dependency code meets the key: every
  file must be a regular file under `src/`, `specs/`, `test/` or `docs/decisions/`,
  outside `test/fixtures/`, and the patch must read exactly as `git diff` writes one.
  Then it opens the draft PR with the App's token, so CI runs on it.
- No workflow restores an Actions cache, and a last job deletes every cache entry written
  while the agent ran (below).
- A maintainer reviews, commits the refreshed page as the fixture, and merges.

Claude Sonnet 5.5 through `anthropics/claude-code-action`, at most 30 turns and $2
(`--max-budget-usd`), no retry.

## Consequences
An outage costs one agent run, and the maintainer starts from a draft that passes CI, or
from the agent's note on why it changed nothing. A run is expected to cost $1–2 of the
key's $10. Claude Code stops at the turn that takes it past $2, so the worst case is $2
and that last turn: about $3 with the context cached, at most about $5 if the turn
re-read a near-million-token context uncached. Without the budget, 30 turns near a large
cached context could have spent most of the key in one run.

The agent can't commit the fixture its fix needs. It can't download pages, a saved page
is too large to write through edits, and an edited page would be fabricated evidence, so
the check rejects any change under `test/fixtures/`. It copies the markup that drifted
into a test instead, and the maintainer commits the refreshed page before merging.

The agent's tool list is not a boundary: `pnpm verify` runs tests it wrote, as the same
user as every other step, so from its step on the rest of its job is within reach: later
steps and post steps, the Actions runtime token they get, files the job uploads, the
model's key in the job's memory. Four things follow:
- **The cache service stays in reach.** harden-runner always allows GitHub's Actions
  service (`*.actions.githubusercontent.com`) and its storage
  (`productionresultssa*.blob.core.windows.net`), whatever the job's allowlist says
  (`addImplicitEndpoints` in step-security/agent v0.17.0, the agent v2.22.1 installs). So
  the agent's code can write a cache entry for `main`: an archive that the job restoring
  it unpacks at whatever absolute paths it names, such as another action's code. Taking
  the artifacts out of the agent's job wouldn't change that, so they stay.
- **So no workflow restores a cache.** `pnpm/setup` restores and saves its
  lockfile-verification log even with `cache: false`; it is keyed on the lockfile's
  hash, so every workflow also points `cache-dependency-path` at a file that never
  exists, and `pnpm/setup` touches no cache at all. A test holds every workflow to it.
  Each job pays for its install, a few seconds.
- **And the agent's cache entries are deleted.** CodeQL's default setup, which the
  workflows don't configure, is the one reader left: its PR runs restore
  `codeql-overlay-base-database-*` from main's cache and unpack it with `tar -P`, at the
  absolute paths it names. A poisoned entry would run code in a CodeQL job, which holds
  `security-events: write` and reads the repository: a low-privilege execution risk, not
  a way to either key. The `caches` job deletes every entry created since the gate,
  listing by creation time until none is left, and fails if it can't; the draft PR, whose
  own CodeQL run would restore one, opens only after it succeeds. The risk is open from
  the agent's first `pnpm verify` until the sweep ends, up to about half an hour (the
  agent's job alone can last 28 minutes), and for as long as the runtime token stays
  valid, about six hours, if the agent's code sent it out. Turning off CodeQL's overlay
  analysis closes it; that is a setting, and the maintainer's call.
- **The key can leak.** Code the agent runs can send the key to an account of its own on
  GitHub or in GitHub's storage, into the run's public artifacts, or through
  `api.anthropic.com` itself, with a key of its own. The patch check rejects a patch or a
  note with anything that looks like a key or a token, but not one encoded to hide it.
  The key's $10 spend limit bounds the loss; a draft or a run that looks odd means
  rotating the key. Nothing else is there to take: the agent's token only reads, and the
  App's key is never in its job.

Claude Code's sandbox for the agent's commands (bubblewrap) would keep them from the rest
of the job: from the runtime token, and so from the cache, and from the key. It needs
packages installed with sudo before harden-runner turns sudo off, and hasn't been tried
on a runner, so it is left for later.

The marker that limits a run per outage is a comment, so anyone who can make
`github-actions[bot]` post one could suppress the agent; nobody can make it run more.
A replay (`workflow_dispatch`) skips that limit, and the gate still requires a failed run
with a drift artifact.

The PR job runs one repository file next to the App's key, which [0022](0022-the-app-key-never-meets-dependency-code.md)'s
`publish` doesn't. It is reviewed code from the commit the agent started from, with no
imports a dependency could hide in, and a test fails if it gains one.

Claude Code is installed from npm with `npm ci`, from a lockfile in `.github/drift-fix/`
that pins the version the action would install and its integrity hashes, rather than by
the action's installer, which downloads from Anthropic's own hosts. The allowlist stays at
the hosts the setup already needs. The lockfile is bumped by hand, with the action. (Since
[0032](0032-one-claude-code-pin.md), the action installs it: two pins could drift apart.)

Rejected:
- GitHub Agentic Workflows, which models this loop natively but is in public preview.
- The agent opening the PR itself: its job would need a token that writes.
- Checking the patch in a job of its own with the repository's dependencies, and handing
  the verdict to the PR job: the PR job would then trust a job that ran dependency code.
- Refreshing the pages in the agent's job: the site would join the allowlist, and the
  pages would come from the job that runs the model.
- The agent replacing fixtures with the refreshed pages: most pin v1.1 data on purpose,
  and their tests would break for reasons other than the drift.
- Handing the patch to the PR job as a job output, to take the artifact hosts out of the
  agent's allowlist: harden-runner allows them anyway (above).
