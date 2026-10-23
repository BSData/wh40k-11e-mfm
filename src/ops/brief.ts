/**
 * The "In brief" of an update PR: a few sentences by a model, above the changelog, for
 * readers who never open the detail. This file turns the model's answer into the quote the
 * PR body holds, puts it where the body marks the place, and keeps the open PR's brief
 * while the changelog under it is the same. `scrape.yml`'s `brief` job runs this file, and
 * that job holds the model's API key, so it imports Node's own modules and nothing else,
 * not even the rest of `src/`, and runs under plain Node (`node --experimental-strip-types`)
 * with no node_modules. A test holds it to that. See "In brief, by a model" in
 * specs/change-tracking.md, and
 * [0033](../../docs/decisions/0033-a-model-sums-up-each-update.md).
 *
 * The answer comes from a model that read text scraped from a website, so it is untrusted:
 * only plain text of it is kept (see `briefBlock`). A brief is a nicety, so an answer that
 * can't be used is dropped, not repaired.
 */

/** Where `changelog()` marks the place of the brief in the PR body. */
export const BRIEF_MARKER = '<!-- mfm-brief -->';
/** Closes the brief, so the next run can find it in the open PR's body. */
export const BRIEF_END = '<!-- /mfm-brief -->';
/** The room `changelog()` keeps in a PR body for the quote, its two markers included. */
export const BRIEF_ROOM = 1_500;
/** GitHub's cap on a PR body, in characters: the renderer's (`src/diff/markdown.ts`). */
export const BODY_LIMIT = 65_536;
/** The model that writes the brief. */
export const MODEL = 'claude-opus-5-5';

/**
 * The quote's first line, and what marks the brief as machine-written (issue #79): the
 * reader is told who wrote it, that nobody read it line by line, and what to trust instead.
 */
export const HEADER = `**In brief** · written by a model (\`${MODEL}\`) from the changelog below, and not checked line by line: the changelog is the record.`;

/**
 * Everything but letters, marks, digits, dashes, quotation marks, spaces, line breaks and
 * `. , ; : ! ? ' " ( ) / % + × → ▲ ▼ ·`. What is left holds no HTML, mention or `#12`
 * issue reference, and the changelog's names, numbers and arrows survive.
 */
const NOT_PLAIN = /[^\p{L}\p{M}\p{N}\p{Pd}\p{Pi}\p{Pf} \n.,;:!?'"()/%+×→▲▼·]/gu;
/** What GitHub links on its own, or what reads as an issue reference. */
const LINK = /\b(?:https?|ftp):\/\/|\bwww\.|\bgh-\d/iu;

/**
 * The quote for the model's answer, or why the answer isn't used. Each paragraph becomes
 * one line of the quote, under the `HEADER`.
 */
export function briefBlock(answer: string): { block: string } | { reason: string } {
  const paragraphs = answer
    .replace(/\r\n?/g, '\n')
    .replace(NOT_PLAIN, '')
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .filter((paragraph) => paragraph !== '');
  if (paragraphs.length === 0) return { reason: 'the answer is empty' };
  if (LINK.test(paragraphs.join('\n\n'))) {
    return { reason: 'the answer has a link or an issue reference' };
  }
  const quote = paragraphs.map((paragraph) => `> ${paragraph}`).join('\n>\n');
  const block = `${BRIEF_MARKER}\n> ${HEADER}\n>\n${quote}\n\n${BRIEF_END}`;
  if (block.length > BRIEF_ROOM) {
    return { reason: `the brief is over ${BRIEF_ROOM.toLocaleString('en-US')} characters` };
  }
  return { block };
}

/**
 * `body` with `block` in place of its `BRIEF_MARKER`, or undefined when there is no mark to
 * take the place of or the result is over GitHub's limit. Spliced by position, not with
 * `String.prototype.replace`, which expands `$&`, `$'` and `$1` in a replacement string.
 */
export function insertBrief(body: string, block: string): string | undefined {
  const at = body.indexOf(BRIEF_MARKER);
  if (at === -1) return undefined;
  const inserted = body.slice(0, at) + block + body.slice(at + BRIEF_MARKER.length);
  return inserted.length > BODY_LIMIT ? undefined : inserted;
}

/** GitHub may hand a body back with CRLF line breaks and without its final line break. */
const normalised = (text: string): string => text.replace(/\r\n?/g, '\n').trimEnd();
/**
 * An update with a rules change is dated the day it is scraped and re-dated by each daily
 * re-scrape until it merges, and the brief names no dates: a date is not a change.
 */
const undated = (text: string): string => text.replace(/\d{4}-\d{2}-\d{2}/g, 'YYYY-MM-DD');

/**
 * The brief of the open PR's `previous` body, when that body with its brief put back to the
 * mark is the new `body`: the changelog is the same, so the brief still describes it, and
 * no new one is needed. Line endings, trailing whitespace and dates don't count as a
 * change. Undefined when `previous` has no brief or the changelog changed.
 */
export function keptBrief(previous: string, body: string): string | undefined {
  const before = normalised(previous);
  const start = before.indexOf(BRIEF_MARKER);
  if (start === -1) return undefined;
  const end = before.indexOf(BRIEF_END, start);
  if (end === -1) return undefined;
  const stop = end + BRIEF_END.length;
  const unmarked = before.slice(0, start) + BRIEF_MARKER + before.slice(stop);
  return undated(unmarked) === undated(normalised(body)) ? before.slice(start, stop) : undefined;
}
