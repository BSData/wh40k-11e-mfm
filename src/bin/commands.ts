import type { Command } from './command.js';

export { type Command, type Io, UsageError } from './command.js';

/**
 * A subcommand as `mfm --help` lists it. Its module, `commands/<name>.ts`, is imported
 * only when it runs, so each command loads only what it uses: the GitHub chores, which
 * hold `GH_TOKEN`, load no parser, browser or YAML library, and a broken import anywhere
 * else can't stop the failure report.
 */
export interface Entry {
  summary: string;
  load(): Promise<Command>;
}

const lazy = (summary: string, load: () => Promise<{ command: Command }>): Entry => ({
  summary,
  load: async () => (await load()).command,
});

/** Every subcommand of `mfm`, in the order `mfm --help` lists them. */
export const COMMANDS: Record<string, Entry> = {
  scrape: lazy(
    'scrape the MFM into data/: index, faction pages, validated YAML',
    () => import('./commands/scrape.js'),
  ),
  render: lazy(
    'print a faction page as Google Chrome renders it, for troubleshooting',
    () => import('./commands/render.js'),
  ),
  diff: lazy(
    "the update's PR body: the changelog between two snapshots",
    () => import('./commands/diff.js'),
  ),
  announce: lazy(
    "the update's Discord message: preview it, or post or edit it",
    () => import('./commands/announce.js'),
  ),
  attention: lazy(
    'the changes that look like a misread, and the needs-attention label',
    () => import('./commands/attention.js'),
  ),
  plan: lazy(
    'where the update PR goes: its branch, its base, and the PRs below it',
    () => import('./commands/plan.js'),
  ),
  changelog: lazy(
    "write the update's entry into changelog/ and regenerate DATA-CHANGELOG.md",
    () => import('./commands/changelog.js'),
  ),
  'open-prs': lazy(
    "list the open update PRs and copy each one's data/",
    () => import('./commands/open-prs.js'),
  ),
  'branch-data': lazy(
    "copy a branch's data/ from origin",
    () => import('./commands/branch-data.js'),
  ),
  'check-data': lazy(
    'check that the committed generated files are what the tools write',
    () => import('./commands/check-data.js'),
  ),
  'refresh-fixtures': lazy(
    're-download the parser test fixtures from the live site',
    () => import('./commands/refresh-fixtures.js'),
  ),
  'report-failure': lazy(
    'open the scrape-failure issue, or comment on the open one',
    () => import('./commands/report-failure.js'),
  ),
  'resolve-failure': lazy(
    'close the open scrape-failure issues after a successful run',
    () => import('./commands/resolve-failure.js'),
  ),
};
