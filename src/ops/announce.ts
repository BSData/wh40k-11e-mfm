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

/** The message id recorded on update PR `pr`, if any. */
export async function readMessageId(gh: GitHub, pr: number): Promise<string | undefined> {
  const comments = await paginate<{ body?: string | null }>(
    gh,
    `/issues/${pr}/comments?per_page=100`,
  );
  return recordedMessageId(comments.map((c) => c.body ?? ''));
}

/**
 * Announce an update on Discord through webhook `hook`: edit the message update PR `pr`
 * records (or `messageId`, when given), or post a new one and record that. Returns the
 * newly posted message, or `undefined` when one was edited.
 */
export async function announceOnPr(
  gh: GitHub,
  pr: number,
  hook: string,
  message: DiscordMessage,
  messageId?: string,
): Promise<Posted | undefined> {
  const id = messageId || (await readMessageId(gh, pr));
  const posted = await send(hook, message, id);
  if (posted) {
    await request(gh, 'POST', `/issues/${pr}/comments`, { body: markerComment(posted) });
  }
  return posted;
}
