/** Whitespace, as every parse step reads text. */

/** Collapse whitespace and trim. */
export function clean(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
