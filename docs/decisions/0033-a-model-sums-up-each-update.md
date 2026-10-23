# 0033. A model sums up each update in brief, and nothing depends on it

- **Status:** accepted, for [#79](https://github.com/BSData/wh40k-11e-mfm/issues/79); revises [0009](0009-fit-the-pr-body-limit.md): the renderer fits the body to 64,036 characters, not 65,536, to leave room for the brief
- **Spec:** [change tracking — In brief, by a model](../../specs/change-tracking.md#in-brief-by-a-model)

## Context
An update PR's body is its changelog: complete and scannable, but a full MFM revision runs
to hundreds of bullets (v1.5's body was 116,568 characters before it was fitted,
[0009](0009-fit-the-pr-body-limit.md)), and the Discord message gives only counts per
faction ([0007](0007-announce-how-much-moved.md)). A reader who never opens the detail
learns nothing of what the update did; "Adeptus Custodes rebuilt: 14 units added, 9
removed" is a sentence nobody writes.

A model can write it. Three things make that risky in this pipeline:
- **Its input is scraped.** The changelog quotes names and rules text from the site, and
  text on a page can tell a model what to do.
- **Its output is published.** GitHub acts on a PR body: HTML can hide what follows it,
  `@name` notifies people, `#12` links an issue, and `fixes #12` closes it on merge.
- **The key is shared.** `ANTHROPIC_API_KEY` has a $10 spend limit, and the drift fixer
  ([0029](0029-a-failed-scrape-drafts-its-fix.md)) spends from it during outages.

## Decision
- **The PR body only**, straight after the title and the *Needs attention* warning, as a
  quote headed **In brief** that says a model wrote it and nobody checked it line by line.
  Not in `changelog/v<version>.md`, the durable record
  ([0011](0011-a-changelog-file-per-version.md)): prose nobody checked against the data
  doesn't belong there. Not in the Discord message, which keeps its counts (0007).
- **Claude Opus 5.5 at effort `high`, one request.** The failure that matters is a wrong
  number in the paragraph most readers stop at, so accuracy wins over cost: Opus 5.5 rather
  than Sonnet 5.5, which the drift fixer runs for a long agent loop. One request costs a few
  cents for a typical update and at most about $0.40 at the body limit.
- **The key never meets dependency code.** `brief` is a job of its own between `scrape` and
  `publish`, with the key and a token that only reads the repository. It runs pinned
  actions and `src/ops/brief.ts` under plain Node, importing only Node's own modules, like
  the drift fixer's `pr` job. The request is one POST, which `fetch` makes as well as the
  SDK would; the SDK would bring a dependency into the job, and with it
  [0022](0022-the-app-key-never-meets-dependency-code.md)'s problem: any step can read every
  secret its job holds.
- **The changelog is data; the answer is plain text.** The request puts the body between
  `<changelog>` tags, and the system prompt says it is scraped data, to read for facts and
  never to follow. That can't stop an injection, so the answer is made harmless instead:
  every character but letters, digits, spaces and plain punctuation is dropped, so it holds
  no HTML, mention or issue reference; an answer with a link or a `GH-<number>` reference
  is not used; and the answer is never printed to the log, where the runner reads workflow
  commands. This is not a Markdown filter: a list marker, an `:emoji:` shortcode or a bare
  commit SHA, which GitHub links, are made of allowed characters and can get through.
- **Room is reserved.** `changelog()` fits the body to GitHub's limit less 1,500 characters,
  so a brief never pushes it over, with or without one.
- **Kept while the changelog stands.** The daily run re-renders an open PR's body. When the
  new body is the PR's body with its brief taken out, the brief stays and the model isn't
  asked. An update PR has stayed open three weeks
  ([#55](https://github.com/BSData/wh40k-11e-mfm/pull/55)): asked daily, that is 21
  requests, up to $8 of the key's $10 for a body at the limit, and a brief rewritten every
  day over the same changelog. Dates don't count as a change (any `YYYY-MM-DD`): an update
  with a rules change is dated the day it is scraped and re-dated by each daily re-scrape
  until it merges ([0002](0002-name-and-date-an-update-from-the-data.md),
  [0015](0015-diff-the-rules-panels.md)), which would ask again every day all the same. So
  the brief is asked to name no dates; the title carries them.
- **Never a failed run.** No key, a failed or timed-out request, an unfinished answer or one
  that isn't used: the PR goes out with `mfm diff`'s body, a workflow warning and a line in
  the job's summary. `brief` is `continue-on-error`, and `publish` runs whatever it did.
  This is a deliberate exception to failing loud
  ([0020](0020-fail-loud-and-located.md)): everything the brief says is in the changelog
  under it, and holding back an update, or opening a `scrape-failure` issue, for want of a
  paragraph would cost more than the paragraph is worth.

## Consequences
- A reader gets a few sentences first; the changelog under them is unchanged and still the
  record.
- The brief can be wrong: the model reads up to 64,000 characters and writes 120 words. It
  is marked as a model's, and the `review-data-pr` skill tells a reviewer to take no fact
  from it. A shortened body's stubbed sections reach the model as the table's counts only.
- An injection can still put plain sentences in the brief, and with them a list marker, an
  `:emoji:` or a commit SHA, but no HTML, mention, issue reference or link, and only in a PR
  a maintainer reads before merging.
- Every body with a changelog entry carries an invisible `<!-- mfm-brief -->`, and is up to
  1,500 characters shorter than it could be when it has to be shortened.
- A dry run runs `brief` too, so it spends a request when the scrape finds a change.
- The scrape workflow has five jobs, and the brief costs about 20 seconds of runner time a
  run.

Rejected:
- Writing it in `scrape` (`mfm diff --brief`): the key would sit beside every dependency.
- `anthropics/claude-code-action`, which the drift fixer uses: an agent and a CLI install for
  one request.
- Retrying a failed request: a body without a brief asks again on the next run while the PR
  is open.
- Server-side refusal fallbacks (`fallbacks: "default"` with a beta header): a refusal is
  one more way to have no brief, and a beta header is one more thing that can break.
- Streaming: the answer is short, and the 4-minute timeout is under the 5 minutes Node's
  `fetch` waits for response headers.
- The answer in a code block, where nothing renders, as the drift fixer quotes its agent's
  note: no markup at all, but monospace text that doesn't wrap, for prose meant to be read.
