# 0032. One Claude Code pin: the action installs it

- **Status:** accepted, in [#104](https://github.com/BSData/wh40k-11e-mfm/pull/104); revises [0029](0029-a-failed-scrape-drafts-its-fix.md)
- **Spec:** [change tracking — The drift fixer](../../specs/change-tracking.md#the-drift-fixer)

## Context
The drift fixer pinned Claude Code twice:
- `anthropics/claude-code-action`, pinned by commit, which Dependabot bumps with the other
  actions;
- the Claude Code it ran, installed with `npm ci` from a lockfile in `.github/drift-fix/`.
  That kept Anthropic's download hosts off the agent job's egress allowlist, and pinned
  the package's integrity hashes.

The two have to match. Each action release hardcodes the Claude Code version it installs
(`claudeCodeVersion` in `src/entrypoints/run.ts`), and bundles the Agent SDK built for it
(SDK 0.3.N for Claude Code 2.1.N). The action's own docs warn that an older Claude Code
"may cause problems". Nothing kept them together:
- Dependabot didn't watch `.github/drift-fix/`, and no test compared the two.
- The action releases almost daily: v1.0.251 on 2026-10-15, v1.0.259 a week later.
- The first Dependabot PR to bump the action would have left Claude Code behind. A
  mismatch would only show when the drift fixer runs, which is during an outage: since
  [0031](0031-the-drift-fixer-fails-loud-with-fewer-layers.md) it fails visibly, but it
  spends the outage's one run.

## Decision
The action installs Claude Code itself: no `path_to_claude_code_executable`, and no
`.github/drift-fix/`. The agent job's allowlist gains the installer's two hosts:
`claude.ai`, whose `install.sh` redirects to `downloads.claude.ai`, which serves the
script, the manifests and the binaries. A test holds the allowlist to both. The action's commit is now the only pin, and a Dependabot
bump of it moves Claude Code too. Action bumps change a workflow file, so they still wait
for a maintainer to merge them ([0025](0025-dependabot-minor-and-patch-updates-merge-themselves.md)).

## Consequences
- The pinned version matches the action by construction, with nothing to bump by hand.
- The Claude Code that runs is the same binary as before: npm's 2.1.301 and the
  installer's have the same SHA-256.
- What installs it is less pinned than before:
  - The installer script is fetched live, not from a pinned commit.
  - It downloads the latest release's binary, checks its SHA-256 against that release's
    manifest, then runs it to install the version the action pins.
  - The manifest comes from the same host as the binary. So the check catches a
    corrupted download, but not a compromised host. The pinned release's manifest is
    also signed, but that check is only advisory with nonessential traffic off.
  - The script and that latest binary run inside the agent's step, with the model's key
    in their environment. `claude.ai` stays reachable for the rest of the job: one more
    way out for the key, like GitHub and the model's API (0029, "The key can leak").

  This trusts Anthropic's download hosts as the job already trusts Anthropic's action
  and its API. The job's prize is unchanged: the model's key, with its $10 spend limit,
  and a token that only reads. The App's key is never in this job.
- The installer and the latest binary can change on any day, not just with an action
  release, and the drift fixer only runs during an outage. If one of them moves to
  another host or breaks, the install fails under the egress block. Since 0031 that
  fails the run visibly, and a replay (about $0.15 against a past failure) checks the
  install at any time: after an action bump, say.
- The install counts against the step's 20-minute timeout; it takes about ten seconds.
- `DISABLE_AUTOUPDATER` stays: with `downloads.claude.ai` allowed, it is what keeps
  Claude Code from updating itself during the run.

Rejected:
- **Keep both pins, and add a test that fails when they differ.** It's safe, but someone
  has to bump the lockfile by hand about once a week.
- **A workflow that pushes the matching bump into Dependabot's PR.** More machinery than
  the problem is worth.
- **Read the version from the action's source and install that version from npm.** That
  parses another project's code, which breaks when they rename a variable.
