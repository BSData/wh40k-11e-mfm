# Contributing

Thanks for helping. This repo is a scraper: it reads the Warhammer 40,000 **Munitorum
Field Manual** (<https://mfm.warhammer-community.com/en>), writes it to [`data/`](data/) as
YAML, and keeps a changelog per MFM version. It is not the list-builder data: problems in
New Recruit or BattleScribe belong to [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e/issues).

## Reporting a problem
- **A value in `data/` doesn't match the MFM site.** Use the
  [points mismatch form](https://github.com/BSData/wh40k-11e-mfm/issues/new?template=points-mismatch.yml).
  No code needed. First check the
  [open update PRs](https://github.com/BSData/wh40k-11e-mfm/pulls?q=is%3Apr+is%3Aopen+label%3Amfm-update):
  `main` lags the site until the update PR is merged, and the PR may already have the
  new value.
- **The scraper, the tests or a workflow misbehaves.** Use the
  [bug form](https://github.com/BSData/wh40k-11e-mfm/issues/new?template=bug.yml).
- **You use the data and need a format or a field.** Use the
  [data format request](https://github.com/BSData/wh40k-11e-mfm/issues/new?template=data-format-request.yml).
- **The scheduled scrape failed.** An issue labelled
  [`scrape-failure`](https://github.com/BSData/wh40k-11e-mfm/issues?q=is%3Aissue+is%3Aopen+label%3Ascrape-failure)
  already tracks it (see [When the scrape fails](#when-the-scrape-fails)). Comment there.

## Setup
You need Node 22 or later and pnpm, at the version pinned in `package.json`'s
`packageManager` (`corepack enable` provides it).

```bash
pnpm install                            # also installs the git hooks (lefthook)
pnpm exec playwright install chromium   # only for live scrapes with Legends and the rules panels
```

The hooks run Biome on commit, and the typecheck and the tests on push.

## The offline loop
The tests run against saved MFM pages in `test/fixtures/` and need no network:

```bash
pnpm test         # once
pnpm test:watch   # again on every save
pnpm verify       # before you push: what CI runs
```

`pnpm verify` is `pnpm check && pnpm typecheck && pnpm test`, plus checks that `data/` is
valid and canonical.

A live scrape checks your change against the real site:

```bash
pnpm scrape --faction necrons --no-legends
```

It writes into `data/`. Run `git restore data/` before you commit, unless the PR is meant
to regenerate the data (see [Never hand-edit `data/`](#never-hand-edit-data)).

## Specs first
[`specs/`](specs/) is the source of truth, and the code follows it:
- [`data-model.md`](specs/data-model.md): the YAML shape;
- [`scraping.md`](specs/scraping.md): the parser and the selectors it relies on;
- [`change-tracking.md`](specs/change-tracking.md): the diff, the changelogs, the update
  PRs and the announcements.

Change the spec first, in the same PR, then the code.

## Parser changes need fixture evidence
The MFM site changes its markup without notice; that is the failure this project expects.
Handle only markup that a saved page shows. Refresh or add the fixture with
`pnpm refresh-fixtures`, and add a test that fails without your change. Handling for
markup that no fixture shows gets reverted: #18 added some, and #19 took it out again.

## Never hand-edit `data/`
`data/`, `changelog/` and `DATA-CHANGELOG.md` are scraper output. A wrong value is either a
parser bug (fix the parser, with a fixture) or what the MFM says. If your change alters the
output, regenerate it with `pnpm scrape` and say so in the PR. Check for an open update PR
first, because it writes the same files.

## How updates reach `main`
1. The `Scrape MFM` workflow scrapes the site every day at 16:00 UTC.
2. When anything changed, it opens a PR for that MFM version on the branch
   `mfm/v<version>`, labelled `mfm-update`. The PR body is the changelog, and the commit
   adds the same entry to `changelog/v<version>.md`.
3. While that version is live, every run force-pushes the same branch. Don't push to
   `mfm/*` branches: the next run overwrites them.
4. If GW publishes a new version before the open PR is merged, the new version's PR is
   stacked on the open one (based on its branch). They merge bottom-up.
5. A maintainer checks the changes against the site and merges. Until then, `main` is
   behind the site.

The details, and the reasons for them, are in
[`specs/change-tracking.md`](specs/change-tracking.md).

## When the scrape fails
A failed run opens an issue labelled `scrape-failure`, with each failing faction's error.
Further failures add comments to that issue rather than opening new ones, and the next
successful run closes it. To fix it, follow the "When a scrape breaks" runbook linked from
[`AGENTS.md`](AGENTS.md): refresh the fixture, find the selector that drifted, fix it, and
re-test. Then open a PR that links the issue.

## Pull requests
- One change per PR, linked to the issue it closes.
- Fill in the checklist in the PR template.
- CI runs on every PR, and the code owners in [`.github/CODEOWNERS`](.github/CODEOWNERS)
  review it.
- Write commit subjects in the imperative, in plain English, as in `git log`.

## Coding agents
[`AGENTS.md`](AGENTS.md) is the entry point for coding agents: the project map, the
commands, the conventions and the runbooks. Everything on this page applies to
agent-written PRs too, including a review by someone who reads the diff.

## Conduct and license
The [BSData Code of Conduct](https://github.com/BSData/.github/blob/main/CODE_OF_CONDUCT.md)
applies here. Code you contribute is released under the [MIT License](LICENSE); the
[License section of the README](README.md#license) explains what that covers and what it
doesn't.
