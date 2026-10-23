import { clean } from './text.js';

/** Names as the dataset spells them, from the site's ALL-CAPS labels. */

/** Convert the site's ALL-CAPS labels to readable Title Case, deterministically. */
export function titleCase(s: string): string {
  return clean(s)
    .toLowerCase()
    .replace(/(^|[\s'’(-])([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
}
