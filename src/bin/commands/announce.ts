import { loadSnapshots } from '../../diff.js';
import { type AnnounceOpts, announcement, send, webhookUrl } from '../../discord.js';
import { announceOnPr } from '../../ops/announce.js';
import { githubFromEnv } from '../../ops/github.js';
import { type Command, flag, prNumber, text, UsageError } from '../command.js';

export const command: Command = {
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
    const { before, after, meta } = loadSnapshots(beforeDir, afterDir);
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
