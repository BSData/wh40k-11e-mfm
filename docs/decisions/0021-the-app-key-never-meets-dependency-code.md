# 0021. Update PRs are opened with the App's token, in a job that runs no dependency code

- **Status:** accepted, [#91](https://github.com/BSData/wh40k-11e-mfm/pull/91)
- **Spec:** [change tracking — The App token](../../specs/change-tracking.md#the-app-token)

## Context
The update PR was opened with the workflow's `GITHUB_TOKEN`, and events made with that
token start no workflows. So the update PRs got no CI at all ([#55](https://github.com/BSData/wh40k-11e-mfm/pull/55) ran no checks), and
`build` couldn't be made a required check without making every update PR unmergeable.

A token from the project's GitHub App, `bsdata-automaton`, does start workflows. But the
App is installed across the organisation, with write access to contents, pull requests,
issues and Actions, so its private key can mint a token for every repository it is
installed on. And any step of a job can read every secret that job uses: on a hosted
runner a step can read the runner's memory, which is how the 2025 `tj-actions` compromise
harvested secrets. The scrape job runs `pnpm install`, Playwright's browser download and
all of the npm code the scraper depends on.

## Decision
The scrape workflow is split by what each part needs. `scrape` runs every dependency, with
no secrets and a token that only reads, and hands the staged update on as an artifact.
`publish` is the only job that holds the App's key, and runs nothing but pinned actions
and a file copy: it checks out the base afresh, copies the staged files in, mints a token
scoped to this repository with `contents: write` and `pull-requests: write`, and runs
`create-pull-request` with it. It takes no `.git` from the artifact, since git config can
run commands. `announce` and `report` run our code again, with the default token.

## Consequences
The update PR gets CI, so `build` can be required. A compromised dependency can still
corrupt the data the PR proposes, which a reviewer reads, but it can't reach the key.

The workflow has four jobs and an artifact instead of one job, and each job that runs our
code installs the dependencies again, about a minute each.

The stack link and the Discord marker use the default token. Neither needs to start a
workflow, and the marker must be `github-actions[bot]`'s anyway
([0006](0006-one-discord-message-per-update.md)). The failure issue is still opened with
the default token too, so it starts no workflow either.

The App has no Workflows permission, so its token can't push a change to
`.github/workflows/`. The update commit only touches `data/` and the changelog.

Rejected: down-scoped tokens per step in the one job, which the first version of #91 used.
They narrow what a dependency reading its environment finds, but not what it can read
from memory: the key itself. Limiting the App's installation to fewer repositories is
good hygiene, and is the organisation's call. The workflow has to be safe without it.
