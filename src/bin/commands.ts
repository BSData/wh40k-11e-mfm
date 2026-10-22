import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ParseArgsOptionsConfig } from 'node:util';
import { z } from 'zod';
import { changelogIndex, withEntry } from '../changelog.js';
import { checkData, INDEX, readGeneratedFiles } from '../check-data.js';
import {
  changelog,
  changelogEntry,
  changelogFile,
  loadFactionDir,
  loadMeta,
  loadVersion,
  updateTitle,
  updateVersion,
  updateWindow,
  windowLabel,
} from '../diff.js';
import { type AnnounceOpts, announcement, send, webhookUrl } from '../discord.js';
import { announceOnPr } from '../ops/announce.js';
import { reportFailure, resolveFailure } from '../ops/failure-issue.js';
import { githubFromEnv, runUrl } from '../ops/github.js';
import { exportBranchData, exportOpenPrs } from '../ops/open-prs.js';
import { writeOutputs } from '../ops/outputs.js';
import { planUpdate, UpdatePr } from '../stack.js';

/**
 * The subcommands of `mfm` (`src/bin/mfm.ts`): each one's options, its `--help`, and a
 * thin `run` over the modules that do the work. What a command prints on stdout is its
 * result; progress and notes go to stderr.
 */

export interface Io {
  out(text: string): void;
  err(text: string): void;
}

export type Values = Record<string, string | boolean | (string | boolean)[] | undefined>;

export interface Command {
  /** One line, for `mfm --help`. */
  summary: string;
  /** The whole `--help` text. */
  help: string;
  options: ParseArgsOptionsConfig;
  /** Exactly how many positional arguments it takes. */
  positionals: number;
  run(values: Values, positionals: string[], io: Io): Promise<number>;
}

/** A command line the command can't run: `mfm` prints it with the command's help. */
export class UsageError extends Error {}

const text = (values: Values, name: string): string | undefined => {
  const v = values[name];
  return typeof v === 'string' ? v : undefined;
};

const flag = (values: Values, name: string): boolean => values[name] === true;

const required = (values: Values, name: string): string => {
  const v = text(values, name);
  if (!v) throw new UsageError(`--${name} is required`);
  return v;
};

const prNumber = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  if (!/^[0-9]+$/.test(value)) throw new UsageError(`Not a PR number: ${value}`);
  return Number(value);
};

/** Both snapshots and their `meta.yaml`, as every report compares them. */
function snapshots(beforeDir: string, afterDir: string) {
  return {
    before: loadFactionDir(beforeDir),
    after: loadFactionDir(afterDir),
    meta: { before: loadMeta(beforeDir), after: loadMeta(afterDir) },
  };
}

const diff: Command = {
  summary: "the update's PR body: the changelog between two snapshots",
  help: `usage: mfm diff <beforeDir> <afterDir> [--body-file <path>] [--output <file>]

Prints the update's PR body: the changelog between two data/ snapshots, or
"No changes detected." when there are none.

  --body-file <path>  also write the body to <path>
  --output <file>     append the update's title (title=…) to a step-output file,
                      such as $GITHUB_OUTPUT
`,
  options: { 'body-file': { type: 'string' }, output: { type: 'string' } },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const { before, after, meta } = snapshots(beforeDir, afterDir);
    const body = changelog(before, after, { meta });
    const bodyFile = text(values, 'body-file');
    if (bodyFile) writeFileSync(bodyFile, body);
    // The workflow gives the title to the PR and to its commit.
    const output = text(values, 'output');
    if (output) writeOutputs({ title: updateTitle(before, after, { meta }) }, output, io.out);
    io.out(body);
    return 0;
  },
};

const announce: Command = {
  summary: "the update's Discord message: preview it, or post or edit it",
  help: `usage: mfm announce <beforeDir> <afterDir> [options]

Prints the update's Discord webhook payload, a preview. Prints nothing (and says so on
stderr) when the snapshots are identical.

  --send                 post it to $DISCORD_WEBHOOK_URL instead, or edit the message
                         --message-id names; prints a new message's "<id> <permalink>".
                         Without $DISCORD_WEBHOOK_URL it says so and does nothing.
  --message-id <id>      the message to edit
  --record               with --send and --pr-number: read the message to edit from
                         the PR's marker comment, and leave a marker there after posting
                         a new one (needs GITHUB_REPOSITORY and GH_TOKEN)
  --pr-number <n>        the open update PR, which the message links to
  --pr-url <url>         that PR's address
  --changelog-url <url>  the link when there is no PR
  --today <date>         today, YYYY-MM-DD (default: the clock)
`,
  options: {
    send: { type: 'boolean' },
    'message-id': { type: 'string' },
    record: { type: 'boolean' },
    'pr-number': { type: 'string' },
    'pr-url': { type: 'string' },
    'changelog-url': { type: 'string' },
    today: { type: 'string' },
  },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const pr = prNumber(text(values, 'pr-number'));
    const record = flag(values, 'record');
    if (record && (pr === undefined || !flag(values, 'send'))) {
      throw new UsageError('--record needs --send and --pr-number');
    }
    const opts: AnnounceOpts = {};
    if (pr !== undefined) opts.prNumber = pr;
    for (const [flag, key] of [
      ['pr-url', 'prUrl'],
      ['changelog-url', 'changelogUrl'],
      ['today', 'today'],
    ] as const) {
      const v = text(values, flag);
      if (v !== undefined) opts[key] = v;
    }
    const { before, after, meta } = snapshots(beforeDir, afterDir);
    const message = announcement(before, after, { ...opts, meta });

    if (!message) io.err('No data changes — nothing to announce.\n');
    else if (!flag(values, 'send')) io.out(`${JSON.stringify(message)}\n`);
    else {
      // biome-ignore lint/complexity/useLiteralKeys: tsc's noPropertyAccessFromIndexSignature requires the bracket form on process.env, and the two rules disagree.
      const raw = process.env['DISCORD_WEBHOOK_URL'];
      // No secret configured (a fork, or a repo that hasn't set one up) is not a failure.
      if (!raw) {
        io.err('DISCORD_WEBHOOK_URL is not set — skipping the announcement.\n');
        return 0;
      }
      const hook = webhookUrl(raw);
      const messageId = text(values, 'message-id') || undefined;
      if (record && pr !== undefined) {
        const posted = await announceOnPr(githubFromEnv(), pr, hook, message, messageId);
        io.err(
          posted ? `Posted message ${posted.id}, recorded on #${pr}.\n` : 'Edited the message.\n',
        );
        return 0;
      }
      const posted = await send(hook, message, messageId);
      // "<id> [permalink]": the id is what --message-id edits, the link is for a reader.
      if (posted) io.out(`${posted.id}${posted.url ? ` ${posted.url}` : ''}\n`);
      io.err(posted ? `Posted message ${posted.id}.\n` : `Edited message ${messageId}.\n`);
    }
    return 0;
  },
};

const plan: Command = {
  summary: 'where the update PR goes: its branch, its base, and the PRs below it',
  help: `usage: mfm plan <openPrs.json> <scrapedDataDir> [--output <file>]

Plans the update PR for the scraped site version (from <scrapedDataDir>/meta.yaml),
given the open PRs (\`mfm open-prs --json\`), and prints it as step outputs: branch=…,
base=… and below=… (the PRs below it, bottom first, space-separated).

  --output <file>  append them to a step-output file, such as $GITHUB_OUTPUT, instead
`,
  options: { output: { type: 'string' } },
  positionals: 2,
  async run(values, [prsFile = '', dataDir = ''], io) {
    const version = loadVersion(dataDir);
    if (!version) {
      throw new Error(`No site version in ${dataDir}/meta.yaml, so no update branch to name.`);
    }
    const prs = z.array(UpdatePr).parse(JSON.parse(readFileSync(prsFile, 'utf8')));
    const p = planUpdate(prs, version);
    const outputs = { branch: p.branch, base: p.base, below: p.below.join(' ') };
    writeOutputs(outputs, text(values, 'output'), io.out);
    return 0;
  },
};

const changelogCommand: Command = {
  summary: "write the update's entry into changelog/ and regenerate DATA-CHANGELOG.md",
  help: `usage: mfm changelog <beforeDir> <afterDir> [--date <date>] [--root <dir>]

Writes the changelog entry for the changes between two data/ snapshots into their MFM
version's file (changelog/v1.6.md), then regenerates the ${INDEX} index. Leaves both
untouched when nothing changed.

  --date <date>  the entry's date (default: the days the changed factions were first
                 seen, which is stable across re-scrapes of the update PR)
  --root <dir>   the repository to write into (default: the current directory)
`,
  options: { date: { type: 'string' }, root: { type: 'string' } },
  positionals: 2,
  async run(values, [beforeDir = '', afterDir = ''], io) {
    const root = text(values, 'root') ?? '.';
    const { before, after, meta } = snapshots(beforeDir, afterDir);
    const date = text(values, 'date') ?? windowLabel(updateWindow(before, after));
    const opts = { date, meta };
    const entry = changelogEntry(before, after, opts);
    if (!entry) {
      io.out(`No data changes — changelog and ${INDEX} left untouched.\n`);
      return 0;
    }
    const version = updateVersion(after, opts);
    const file = changelogFile(version);
    const path = join(root, file);
    mkdirSync(dirname(path), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : undefined;
    writeFileSync(path, withEntry(current, version, entry));

    const dir = dirname(path);
    const files = readdirSync(dir).map((name) => ({
      name,
      text: readFileSync(join(dir, name), 'utf8'),
    }));
    writeFileSync(join(root, INDEX), changelogIndex(files));
    io.out(`Wrote a ${date} entry to ${file} and regenerated ${INDEX}.\n`);
    return 0;
  },
};

const openPrs: Command = {
  summary: "list the open update PRs and copy each one's data/",
  help: `usage: mfm open-prs --out <dir> --json <file> [--output <file>]

Lists the open update PRs (label mfm-update, an mfm/ branch of this repository) into
<file>, for \`mfm plan\`, and copies each one's data/ into <dir>/<branch>. Prints a
step output, dates=…, with a --dates-from for each copy, for \`pnpm scrape\`. Needs
GITHUB_REPOSITORY and GH_TOKEN, and runs git in a checkout whose origin is GitHub.

  --out <dir>      where the copies go
  --json <file>    where the list goes
  --output <file>  append the step output to a step-output file, such as
                   $GITHUB_OUTPUT, instead
`,
  options: { out: { type: 'string' }, json: { type: 'string' }, output: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const out = required(values, 'out');
    const json = required(values, 'json');
    const { prs, dirs } = await exportOpenPrs(githubFromEnv(), out);
    writeFileSync(json, `${JSON.stringify(prs)}\n`);
    for (const pr of prs) io.err(`Matching dates against the open ${pr.headRefName} PR.\n`);
    const dates = dirs.map((d) => `--dates-from ${d}`).join(' ');
    writeOutputs({ dates }, text(values, 'output'), io.out);
    return 0;
  },
};

const branchData: Command = {
  summary: "copy a branch's data/ from origin",
  help: `usage: mfm branch-data <branch> <dir>

Fetches <branch> from origin, one commit deep, and copies the files under its data/
into <dir>. The checkout itself is left as it is.
`,
  options: {},
  positionals: 2,
  async run(_, [branch = '', dir = ''], io) {
    await exportBranchData(branch, dir);
    io.err(`Copied ${branch}'s data/ into ${dir}.\n`);
    return 0;
  },
};

/** The repository these commands ship in. */
const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const checkDataCommand: Command = {
  summary: 'check that the committed generated files are what the tools write',
  help: `usage: mfm check-data [--root <dir>]

Checks that the committed generated files are exactly what the tools would write (see
"Integrity of the committed files" in specs/data-model.md): every data/<slug>.yaml
passes the Faction schema, is named after its slug and is canonical; data/meta.yaml
passes SiteMeta and is canonical; and ${INDEX} is the index generated from
changelog/. Lists every problem and exits 1 when any file isn't.

  --root <dir>  the repository to check (default: the one this command is in)
`,
  options: { root: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const files = readGeneratedFiles(text(values, 'root') ?? REPO_ROOT);
    const problems = checkData(files);
    if (problems.length === 0) {
      const factions = files.data.filter((f) => f.name !== 'meta.yaml').length;
      io.out(`check-data: ${factions} faction files, meta.yaml and ${INDEX} are canonical.\n`);
      return 0;
    }
    for (const p of problems) io.err(`✗ ${p}\n\n`);
    io.err(
      `check-data: ${problems.length} problem${problems.length === 1 ? '' : 's'}. These files are ` +
        'generated by the scraper; see "Integrity of the committed files" in specs/data-model.md.\n',
    );
    return 1;
  },
};

const reportFailureCommand: Command = {
  summary: 'open the scrape-failure issue, or comment on the open one',
  help: `usage: mfm report-failure [--details <file>]

Reports a failed scrape run: a comment on the open scrape-failure issue, or a new
issue when none is open. Links the run's log. Needs GITHUB_REPOSITORY, GITHUB_RUN_ID
and GH_TOKEN.

  --details <file>  the per-faction report (\`pnpm scrape --report\`); a missing file
                    means the run failed outside parsing
`,
  options: { details: { type: 'string' } },
  positionals: 0,
  async run(values, _, io) {
    const gh = githubFromEnv();
    const file = text(values, 'details');
    const details = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
    const issue = await reportFailure(gh, runUrl(gh), details);
    io.err(`${issue.created ? 'Opened' : 'Commented on'} issue #${issue.number}.\n`);
    return 0;
  },
};

const resolveFailureCommand: Command = {
  summary: 'close the open scrape-failure issues after a successful run',
  help: `usage: mfm resolve-failure

Comments on every open scrape-failure issue with a link to this successful run, and
closes it. Needs GITHUB_REPOSITORY, GITHUB_RUN_ID and GH_TOKEN.
`,
  options: {},
  positionals: 0,
  async run(_, __, io) {
    const gh = githubFromEnv();
    const closed = await resolveFailure(gh, runUrl(gh));
    if (closed.length > 0) io.err(`Closed ${closed.map((n) => `#${n}`).join(', ')}.\n`);
    return 0;
  },
};

export const COMMANDS: Record<string, Command> = {
  diff,
  announce,
  plan,
  changelog: changelogCommand,
  'open-prs': openPrs,
  'branch-data': branchData,
  'check-data': checkDataCommand,
  'report-failure': reportFailureCommand,
  'resolve-failure': resolveFailureCommand,
};
