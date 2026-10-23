import { type DiscordMessage, type Posted, send } from '../discord.js';
import { type GitHub, paginate, request } from './github.js';

/**
 * One Discord message per MFM update, not per scrape run, remembered by a hidden marker
 * on a comment of the update's PR. The PR is the update's identity and lives exactly as
 * long as the update does, so the marker is the whole of the state: no marker means
 * post, a marker means edit that message, and a multi-day update reads as one
 * announcement whose numbers widen. Deleting the comment forces a repost. A failed post
 * leaves no marker, so the next run posts instead of assuming the last one worked.
 */

const MARKER = /<!-- discord-message-id: ([0-9]+) -->/;

/** A Discord id (a snowflake): digits only, so it is safe to write into a comment. */
const SNOWFLAKE = /^[0-9]+$/;
const PERMALINK = /^https:\/\/discord\.com\/channels\/[0-9]+\/[0-9]+\/[0-9]+$/;

/** The message id the comments record: the last comment's marker wins. */
export function recordedMessageId(bodies: readonly string[]): string | undefined {
  let id: string | undefined;
  for (const body of bodies) id = body.match(MARKER)?.[1] ?? id;
  return id;
}

/**
 * The comment that records a newly posted message: its permalink for a reader, and the
 * marker. Throws on an id that isn't a snowflake rather than write it into the PR; a
 * permalink of any other shape is left out.
 */
export function markerComment(posted: Posted): string {
  if (!SNOWFLAKE.test(posted.id)) {
    throw new Error(`Discord returned an unexpected message id: ${JSON.stringify(posted.id)}`);
  }
  const link = posted.url && PERMALINK.test(posted.url) ? posted.url : 'link unavailable';
  return `Announced on Discord: ${link} <!-- discord-message-id: ${posted.id} -->`;
}

/**
 * Who writes the markers: the account behind the workflow's token, `github-actions[bot]`
 * for `GITHUB_TOKEN`. Anyone can comment on a PR, so a marker from anyone else is ignored:
 * otherwise a comment could point the next edit at another message.
 */
export const MARKER_AUTHOR = 'github-actions[bot]';

/** The message id `author` recorded on update PR `pr`, if any. */
export async function readMessageId(
  gh: GitHub,
  pr: number,
  author = MARKER_AUTHOR,
): Promise<string | undefined> {
  const comments = await paginate<{ body?: string | null; user?: { login?: string } | null }>(
    gh,
    `/issues/${pr}/comments?per_page=100`,
  );
  return recordedMessageId(
    comments.filter((c) => c.user?.login === author).map((c) => c.body ?? ''),
  );
}

/**
 * Announce an update on Discord through webhook `hook`: edit the message update PR `pr`
 * records (or `opts.messageId`, when given), or post a new one and record that. Only
 * markers by `opts.author` (default `MARKER_AUTHOR`) count. Returns the newly posted
 * message, or `undefined` when one was edited.
 */
export async function announceOnPr(
  gh: GitHub,
  pr: number,
  hook: string,
  message: DiscordMessage,
  opts: { messageId?: string | undefined; author?: string | undefined } = {},
): Promise<Posted | undefined> {
  const id = opts.messageId || (await readMessageId(gh, pr, opts.author ?? MARKER_AUTHOR));
  const posted = await send(hook, message, id);
  if (posted) {
    await request(gh, 'POST', `/issues/${pr}/comments`, { body: markerComment(posted) });
  }
  return posted;
}
