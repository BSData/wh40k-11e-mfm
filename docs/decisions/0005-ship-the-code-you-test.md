# 0005. Ship the code you test: workflow logic in TypeScript

- **Status:** accepted, [#39](https://github.com/BSData/wh40k-11e-mfm/pull/39) (the Discord sender), extended to the rest of the scrape workflow in [#74](https://github.com/BSData/wh40k-11e-mfm/issues/74)
- **Spec:** [change tracking — Workflow integration](../../specs/change-tracking.md#workflow-integration)

## Context
Sending the Discord announcement is one HTTP call, which briefly argued for `curl` in the
workflow instead of code. That was wrong, and the tell was concrete: verifying the shell
version meant copying it out of the YAML into a file a test could run, so **the thing
verified wasn't the thing that shipped**. Third-party "post to Discord" actions were no
better: they take *their* inputs (a content string, a title, a colour) rather than a
payload, so one would mean fighting a schema and pinning a supply-chain dependency to
render something worse.

The rest of `scrape.yml` had the same problem. The shell loop that exported each open
PR's `data/`, the `jq` that read the Discord marker, and the `github-script` blocks that
opened, commented on and closed the failure issue only ever ran in production. And a step
that captured a command's stdout through `pnpm exec` broke when pnpm printed a line of its
own there.

## Decision
- Logic lives in TypeScript under test: `send()` beside the renderer in `src/discord.ts`,
  and the GitHub chores in `src/ops/`, each tested against a stub HTTP server (and git
  against a local origin). They take a base URL (`GITHUB_API_URL`, the webhook) so a test
  can point them there.
- The workflow only invokes commands: each step is one `mfm` subcommand
  (`src/bin/mfm.ts`), run with `node_modules/.bin/tsx` rather than `pnpm exec`.
- A result a later step reads is written to a file (`--output "$GITHUB_OUTPUT"`,
  `--body-file`), never captured from stdout. Values that reach a comment or a step output
  are checked first: a Discord message id must be a snowflake, and a step output must be
  one line.

## Consequences
The workflow reads as a list of commands, and `mfm <command> --help` documents each one.

The one exception is the failure report's fallback. `mfm report-failure` needs the
checkout and the dependencies, so a run that failed before it had them (checkout,
`pnpm/setup`, the install) could otherwise file no failure issue at all, and an outage
would go unreported. A last step, run only when the report step didn't succeed, files it
with `gh` alone: a comment on the open `scrape-failure` issue, or a new one. It is a few
lines of shell, kept because it must run when nothing else can.

`mfm` loads a command's module only when it runs, so the GitHub chores, which hold
`GH_TOKEN`, import no parser, browser or YAML library, and a broken import elsewhere can't
take out the failure report.
