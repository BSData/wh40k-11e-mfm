import { clean } from './text.js';

/** Names as the dataset spells them, from the site's ALL-CAPS labels. */

/**
 * A tier label from the site's ALL CAPS, every word capitalised: "Your 1st To 2nd Units
 * Cost". Names follow their own rule (`nameCase`).
 */
export function titleCase(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/(^|[\s'’(-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}

/**
 * Words a name keeps lower-case, also inside a hyphenated word, unless the name starts
 * with one: "Anrakyr the Traveller", "Voidsmen-at-Arms".
 */
const MINOR_WORDS = new Set('a an and at by for from in into of on or the to with'.split(' '));

/**
 * Words the official names spell with capitals no rule gives: a capital after an
 * apostrophe (`Lion El’Jonson`) or an initialism (`Centaur RSV`). Each is matched as a
 * whole word, ignoring case and the style of its apostrophes and hyphens. Only the
 * letters come from here; the rest stays as the site writes it. See "Names" in
 * specs/data-model.md.
 */
export const OFFICIAL_SPELLINGS: readonly string[] = [
  'AFV',
  'ATVs',
  'AX-1-0',
  'El’Jonson',
  'RSV',
  'TX42',
  'UR-025',
  'XV9',
];

/** An official spelling's lookup key: lower-case, with one apostrophe and one hyphen. */
const officialKey = (word: string) => word.toLowerCase().replace(/'/g, '’').replace(/‑/g, '-');
const OFFICIAL_BY_KEY = new Map(OFFICIAL_SPELLINGS.map((w) => [officialKey(w), w]));

/** The quotes and brackets that may open a word, before its first letter. */
const OPENING_RE = /^[‘“"'’(]*/;
/** The punctuation that may close a word: a quote, a bracket, a comma, a stop. */
const CLOSING_RE = /[’'”")\],.;:!?]*$/;

/** A word's opening quotes or brackets, the word itself, and its closing punctuation. */
function punctuated(word: string): [open: string, bare: string, close: string] {
  const open = OPENING_RE.exec(word)?.[0] ?? '';
  const rest = word.slice(open.length);
  const close = CLOSING_RE.exec(rest)?.[0] ?? '';
  return [open, rest.slice(0, rest.length - close.length), close];
}

/** Upper-cases the first letter, after any opening quote or bracket: "‘iron" → "‘Iron". */
const capitalise = (part: string) => {
  const open = OPENING_RE.exec(part)?.[0] ?? '';
  const rest = part.slice(open.length);
  return open + rest.charAt(0).toUpperCase() + rest.slice(1);
};

/**
 * A name (unit, detachment, sub-group, attach-list entry) from the site's ALL CAPS, by
 * the "Names" rule in specs/data-model.md. Each word, and each part of a hyphenated
 * word, starts with a capital, after any opening quote or bracket; a letter after an
 * apostrophe inside a word stays lower-case; `MINOR_WORDS` stay lower-case unless the
 * name starts with one; `OFFICIAL_SPELLINGS` are taken as they are. Punctuation around a
 * word doesn't hide it from either list. "EMPEROR’S CHAMPION" → "Emperor’s Champion",
 * "‘IRON HAND’ STRAKEN" → "‘Iron Hand’ Straken".
 */
export function nameCase(s: string): string {
  return clean(s)
    .toLowerCase()
    .split(' ')
    .map((word, i) => {
      const [open, bare, close] = punctuated(word);
      const official = OFFICIAL_BY_KEY.get(officialKey(bare));
      if (official) {
        const letters = [...bare].map((ch, j) => (/\p{L}/u.test(ch) ? official[j] : ch));
        return open + letters.join('') + close;
      }
      return word
        .split(/([-‑])/)
        .map((part, j) => {
          const minor = i + j > 0 && MINOR_WORDS.has(punctuated(part)[1]);
          return minor ? part : capitalise(part);
        })
        .join('');
    })
    .join(' ');
}
