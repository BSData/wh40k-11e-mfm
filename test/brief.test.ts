import { describe, expect, it } from 'vitest';
import { BODY_LIMIT as RENDERED_LIMIT } from '../src/diff.js';
import {
  BODY_LIMIT,
  BRIEF_END,
  BRIEF_MARKER,
  BRIEF_ROOM,
  briefBlock,
  HEADER,
  insertBrief,
  keptBrief,
  MODEL,
} from '../src/ops/brief.js';

/**
 * The brief's quote and its place in the PR body (src/ops/brief.ts): what of a model's
 * answer is used, and where it goes. The model's answer is untrusted, so it is held to plain
 * text before it reaches a body.
 */

/** The quote for an answer that is used; throws with the reason for one that isn't. */
const block = (answer: string): string => {
  const r = briefBlock(answer);
  if ('reason' in r) throw new Error(r.reason);
  return r.block;
};
/** The quote's first paragraph line. */
const firstLine = (answer: string): string => block(answer).split('\n')[3] ?? '';
const BODY = `# MFM v1.6 update — 2026-10-30\n\n${BRIEF_MARKER}\n\n_Automated…_\n\n**1 faction changed**\n`;

describe('briefBlock — the answer as a quote a PR body can hold', () => {
  it('quotes each paragraph under a line that says a model wrote it', () => {
    expect(block('Orks changed most.\n\nNecrons gained a unit.')).toBe(
      `${BRIEF_MARKER}\n> ${HEADER}\n>\n> Orks changed most.\n>\n> Necrons gained a unit.\n\n${BRIEF_END}`,
    );
    expect(HEADER).toBe(
      '**In brief** · written by a model (`claude-opus-5-5`) from the changelog below, and not checked line by line: the changelog is the record.',
    );
  });

  it("joins a paragraph's lines and drops empty ones", () => {
    expect(block('a\nb\r\n\r\n\n\nc  d ')).toBe(
      `${BRIEF_MARKER}\n> ${HEADER}\n>\n> a b\n>\n> c d\n\n${BRIEF_END}`,
    );
  });

  it('keeps nothing that renders or acts on GitHub', () => {
    expect(
      firstLine(
        '<!-- x --> <details>**Orks** _up_ [x](y) ![i](j) @someone #12 owner/repo#3 `code` | ~~s~~ \\ & $1',
      ),
    ).toBe('> !-- x -- detailsOrks up x(y) !i(j) someone 12 owner/repo3 code s 1');
  });

  it('drops control and invisible characters', () => {
    // A right-to-left override, a zero-width space and a bell.
    expect(firstLine('‮Orks​ up\u0007')).toBe('> Orks up');
  });

  it('keeps names, numbers and arrows as the changelog writes them', () => {
    // U+2011 is the non-breaking hyphen the data uses.
    const text =
      'T’au Empire — Kroot Hounds, 10 models: 80 → 90 (+10); ▲5 ▼2, ×3 · Sky‑stalker 50% "new"!?';
    expect(firstLine(text)).toBe(`> ${text}`);
  });

  it.each(['', ' \n\n ', '<>**'])('uses no empty answer: %j', (answer) => {
    expect(briefBlock(answer)).toEqual({ reason: 'the answer is empty' });
  });

  it.each([
    'See https://example.com.',
    'See http://x.y',
    'ftp://x.y',
    'www.example.com',
    'fixes GH-12',
    'gh-7',
  ])('uses no answer with a link or an issue reference: %j', (answer) => {
    expect(briefBlock(answer)).toEqual({
      reason: 'the answer has a link or an issue reference',
    });
  });

  it('uses no answer that makes the quote longer than BRIEF_ROOM', () => {
    const fits = BRIEF_ROOM - block('x').length + 1;
    expect(block('x'.repeat(fits))).toHaveLength(BRIEF_ROOM);
    expect(briefBlock('x'.repeat(fits + 1))).toEqual({
      reason: 'the brief is over 1,500 characters',
    });
  });
});

describe('insertBrief — the quote in place of the mark', () => {
  it('puts the quote where the mark is', () => {
    expect(insertBrief(BODY, 'Q')).toBe(
      '# MFM v1.6 update — 2026-10-30\n\nQ\n\n_Automated…_\n\n**1 faction changed**\n',
    );
  });

  it('inserts a quote as it is, $ and all', () => {
    expect(insertBrief(BODY, "$& $' $1")).toContain("\n\n$& $' $1\n\n");
  });

  it('has nowhere to put one in a body without the mark', () => {
    expect(insertBrief('No changes detected.\n', 'Q')).toBeUndefined();
  });

  it("keeps the body within GitHub's limit", () => {
    const full = `${BRIEF_MARKER}\n${'x'.repeat(BODY_LIMIT - BRIEF_MARKER.length - 1)}`;
    expect(full).toHaveLength(BODY_LIMIT);
    expect(insertBrief(full, BRIEF_MARKER)).toBe(full);
    expect(insertBrief(full, `${BRIEF_MARKER}y`)).toBeUndefined();
  });
});

describe("keptBrief — the open PR's brief, while its changelog is the same", () => {
  const q = block('Orks changed most.');
  const onPr = insertBrief(BODY, q) ?? '';

  it('keeps it when the body around it is the new body', () => {
    expect(keptBrief(onPr, BODY)).toBe(q);
  });

  it('as GitHub may store it: CRLF line breaks, no final line break', () => {
    expect(keptBrief(onPr.replace(/\n/g, '\r\n').trimEnd(), BODY)).toBe(q);
  });

  it('keeps it when only the dates moved', () => {
    expect(keptBrief(onPr, BODY.replace('2026-10-30', '2026-10-31'))).toBe(q);
  });

  it('not once the changelog changed', () => {
    expect(
      keptBrief(onPr, BODY.replace('1 faction changed', '2 factions changed')),
    ).toBeUndefined();
  });

  it('not from a body without one', () => {
    expect(keptBrief(BODY, BODY)).toBeUndefined();
    expect(keptBrief('', BODY)).toBeUndefined();
    expect(keptBrief(`${BRIEF_END}\n${BRIEF_MARKER}`, BODY)).toBeUndefined();
  });
});

describe('the numbers', () => {
  it("agree with the renderer on GitHub's limit", () => {
    expect(BODY_LIMIT).toBe(RENDERED_LIMIT);
    expect(BODY_LIMIT).toBe(65_536);
    expect(BRIEF_ROOM).toBe(1_500);
    expect(MODEL).toBe('claude-opus-5-5');
  });
});
