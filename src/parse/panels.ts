import { type CheerioAPI, load } from 'cheerio';
import { NodeHtmlMarkdown } from 'node-html-markdown';
import { clean } from './text.js';

/** The rules panels ("Welcome…" notes and "Muster Armies"), as Markdown for meta.yaml. */

/**
 * The page's collapsible rules panels, keyed by where they land in `meta.yaml`, each
 * named by (a prefix of) its button label. Their bodies are client-only — rendered
 * by the browser once the button is clicked, never in the HTTP HTML.
 */
export const RULES_PANELS = {
  notes: 'Welcome to the Munitorum Field Manual',
  muster: 'Muster Armies',
} as const;

/**
 * The open panel of the rules collapsible whose button label starts with `label`:
 * the element the button's `aria-controls` names. `null` when the panel is closed
 * (it is then not rendered at all, as on every HTTP page).
 */
export function findPanel($: CheerioAPI, label: string): ReturnType<CheerioAPI> | null {
  const id = $('button')
    .filter((_i, b) => clean($(b).text()).startsWith(label))
    .first()
    .attr('aria-controls');
  const panel = id ? $(`[id="${id}"]`) : null;
  return panel?.length ? panel : null;
}

/** All-caps label standing alone on its line (e.g. "UNITS") — a heading, not bold. */
const PANEL_HEADING_RE = /^[A-Z][A-Z0-9 ()/'’-]+$/;

/**
 * HTML → Markdown for the rules panels. node-html-markdown does the generic work
 * (paragraphs, bold, lists, tables, escaping); the overrides match the panels'
 * layout: a `<br>` is a plain line break (not a trailing-space hard break) and a
 * list always sits in its own paragraph.
 */
const panelMarkdown = new NodeHtmlMarkdown(
  { bulletMarker: '-', maxConsecutiveNewlines: 2 },
  { br: { content: '\n', recurse: false }, 'ol,ul': { surroundingNewlines: 2 } },
);

/**
 * Convert one rendered rules panel to Markdown, keeping its structure: `<b>` →
 * `**bold**`, all-caps standalone labels → `## headings`, lists → bullets, tables →
 * GFM tables. `pageHtml` is a fully-rendered page's HTML (from the browser, with
 * the panel open); returns `''` if the panel isn't open. The one project-specific
 * step is spotting the headings: the site marks them up as plain `<b>` on a line
 * of their own, so they are promoted to `<h2>` before conversion.
 */
function extractPanelMarkdown(pageHtml: string, label: string): string {
  const $ = load(pageHtml);
  const panel = findPanel($, label);
  if (!panel) return '';

  panel.find('b, strong').each((_i, el) => {
    const b = $(el);
    if (!PANEL_HEADING_RE.test(clean(b.text()))) return;
    // Alone on its line: the nearest non-blank siblings are line breaks or nothing.
    const line = b.parent().contents().toArray();
    const at = line.indexOf(el);
    const neighbour = (step: 1 | -1) => {
      let j = at + step;
      while (line[j]?.type === 'text' && !clean($(line[j]).text())) j += step;
      return line[j];
    };
    if ([neighbour(-1), neighbour(1)].every((n) => !n || $(n).is('br')))
      b.replaceWith(`<h2>${b.html()}</h2>`);
  });

  return panelMarkdown
    .translate(panel.html() ?? '')
    .replace(/[^\S\n]+\n/g, '\n') // drop trailing spaces (list items' hard breaks)
    .trim();
}

/** The "Welcome…" help text as Markdown (→ `meta.notes`). See `extractPanelMarkdown`. */
export const extractNotesMarkdown = (pageHtml: string): string =>
  extractPanelMarkdown(pageHtml, RULES_PANELS.notes);

/** The "Muster Armies" army-building rules as Markdown (→ `meta.muster`). */
export const extractMusterMarkdown = (pageHtml: string): string =>
  extractPanelMarkdown(pageHtml, RULES_PANELS.muster);
