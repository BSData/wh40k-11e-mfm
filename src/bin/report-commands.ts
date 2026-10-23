import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { changelogIndex, withEntry } from '../changelog.js';
import { INDEX } from '../check-data.js';
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
import { githubFromEnv } from '../ops/github.js';
import { writeOutputs } from '../ops/outputs.js';
import { planUpdate, UpdatePr } from '../stack.js';
import { type Command, flag, prNumber, text, UsageError } from './command.js';

/** The reports an update publishes: its PR body, its Discord message, its plan, its entry. */

/** Both snapshots and their `meta.yaml`, as every report compares them. */
function snapshots(beforeDir: string, afterDir: string) {
  return {
    before: loadFactionDir(beforeDir),
    after: loadFactionDir(afterDir),
    meta: { before: loadMeta(beforeDir), after: loadMeta(afterDir) },
  };
}

export const diff: Command = {
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

export const announce: Command = {
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
  --marker-author <login>
                         with --record: whose marker comments count, the account
                         behind GH_TOKEN (default: github-actions[bot], which is
                         GITHUB_TOKEN's); markers anyone else wrote are ignored
  --pr-number <n>        the open update PR, which the message links to
  --pr-url <url>         that PR's address
  --changelog-url <url>  the link when there is no PR
  --today <date>         today, YYYY-MM-DD (default: the clock)
`,
  options: {
    send: { type: 'boolean' },
    'message-id': { type: 'string' },
    record: { type: 'boolean' },
    'marker-author': { type: 'string' },
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
        const author = text(values, 'marker-author');
        const posted = await announceOnPr(githubFromEnv(), pr, hook, message, {
          messageId,
          author,
        });
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

export const plan: Command = {
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

export const changelogCommand: Command = {
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
