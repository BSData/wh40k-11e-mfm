# 0029. A failed scrape drafts its own fix, with the model's key and the App's key in separate jobs

- **Status:** accepted, for [#77](https://github.com/BSData/wh40k-11e-mfm/issues/77)
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
- A maintainer reviews, commits the refreshed page as the fixture, and merges.

Claude Sonnet 5.5 through `anthropics/claude-code-action`, at most 30 turns, no retry.

## Consequences
An outage costs one agent run, a dollar or two of the key's $10, and the maintainer
starts from a draft that passes CI, or from the agent's note on why it changed nothing.

The agent can't commit the fixture its fix needs. It can't download pages, a saved page
is too large to write through edits, and an edited page would be fabricated evidence, so
the check rejects any change under `test/fixtures/`. It copies the markup that drifted
into a test instead, and the maintainer commits the refreshed page before merging.

What the egress block can't stop: GitHub and its artifact storage are allowed, and an
injected agent with credentials of its own could write to them, and code the agent runs
can read the model's key from the job's memory. The key's spend limit bounds that. The
patch check rejects anything in the patch or the note that looks like a key or a token,
but not one encoded to hide it, so a draft that looks odd means rotating the key. The
agent's token only reads, and the App's key is never in its job.

The marker that limits a run per outage is a comment, so anyone who can make
`github-actions[bot]` post one could suppress the agent; nobody can make it run more.
A replay (`workflow_dispatch`) skips that limit, and the gate still requires a failed run
with a drift artifact.

The PR job runs one repository file next to the App's key, which [0022](0022-the-app-key-never-meets-dependency-code.md)'s
`publish` doesn't. It is reviewed code from the commit the agent started from, with no
imports a dependency could hide in, and a test fails if it gains one.

Claude Code is installed from npm at the version the action would install, rather than by
the action's installer, which downloads from Anthropic's own hosts: npm versions can't be
replaced, and the allowlist stays at the hosts the setup already needs.

Rejected:
- GitHub Agentic Workflows, which models this loop natively but is in public preview.
- The agent opening the PR itself: its job would need a token that writes.
- Checking the patch in a job of its own with the repository's dependencies, and handing
  the verdict to the PR job: the PR job would then trust a job that ran dependency code.
- Refreshing the pages in the agent's job: the site would join the allowlist, and the
  pages would come from the job that runs the model.
- The agent replacing fixtures with the refreshed pages: most pin v1.1 data on purpose,
  and their tests would break for reasons other than the drift.
