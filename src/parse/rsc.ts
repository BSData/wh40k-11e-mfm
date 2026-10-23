import { clean } from './text.js';

/**
 * The page's React Server Components payload ("flight" data), which Next.js streams into
 * the HTML for React as `self.__next_f.push([1,"…"])` scripts: decoded, searched for a
 * collapsible by its trigger label, and rendered to plain HTML. It carries what the page
 * shows only after a click, such as the rules panels, which the server-rendered markup
 * leaves out. See "The rules panels" in specs/scraping.md.
 *
 * Only the shapes the saved pages show are understood; anything else inside what is
 * rendered throws rather than being guessed at.
 */

/** One row of the payload: JSON (parsed when first read), or a `T` text row. */
type Row = { text: string } | { raw: string; json?: unknown; parsed?: boolean };

/** The payload's rows, by hex id. */
export type Flight = ReadonlyMap<string, Row>;

const PUSH_RE = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;

/** The number of UTF-16 code units in the first `bytes` UTF-8 bytes of `s` from `start`. */
function utf8Span(s: string, start: number, bytes: number): number {
  let i = start;
  for (let n = 0; n < bytes && i < s.length; ) {
    const cp = s.codePointAt(i) as number;
    n += cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4;
    i += cp >= 0x10000 ? 2 : 1;
  }
  return i - start;
}

/**
 * Decode the payload of a page's HTML. Rows are `<hex id>:<JSON>` up to a newline, or
 * `<hex id>:T<hex byte length>,<text>`, whose text may hold newlines. Throws if the page
 * carries no payload at all.
 */
export function readFlight(html: string): Flight {
  const flight = [...html.matchAll(PUSH_RE)].map((m) => JSON.parse(m[1] as string)).join('');
  if (!flight) throw new Error('the page has no RSC payload (no self.__next_f.push scripts)');
  const rows = new Map<string, Row>();
  for (let i = 0; i < flight.length; ) {
    const colon = flight.indexOf(':', i);
    if (colon === -1) break;
    const id = flight.slice(i, colon);
    const text = /^T([0-9a-f]+),/.exec(flight.slice(colon + 1, colon + 20));
    if (text) {
      const start = colon + 1 + (text[0] as string).length;
      const end = start + utf8Span(flight, start, Number.parseInt(text[1] as string, 16));
      rows.set(id, { text: flight.slice(start, end) });
      i = end;
    } else {
      const nl = flight.indexOf('\n', colon);
      const stop = nl === -1 ? flight.length : nl;
      rows.set(id, { raw: flight.slice(colon + 1, stop) });
      i = stop + 1;
    }
  }
  return rows;
}

/** A row's value: its text, or its JSON (`undefined` for a row that isn't JSON, like `I`). */
function rowValue(flight: Flight, id: string): unknown {
  const row = flight.get(id);
  if (!row) return undefined;
  if ('text' in row) return row.text;
  if (!row.parsed) {
    row.parsed = true;
    try {
      row.json = JSON.parse(row.raw);
    } catch {
      row.json = undefined;
    }
  }
  return row.json;
}

/** `I[<module>, <chunks>, "<export name>"]`: the client component a `$L<id>` type names. */
function clientName(flight: Flight, type: string): string | undefined {
  if (!type.startsWith('$L')) return undefined;
  const row = flight.get(type.slice(2));
  if (!row || 'text' in row || !row.raw.startsWith('I[')) return undefined;
  try {
    const ref: unknown = JSON.parse(row.raw.slice(1));
    return Array.isArray(ref) && typeof ref[2] === 'string' ? ref[2] : undefined;
  } catch {
    return undefined;
  }
}

/** An element's props: its children, and whatever else becomes attributes. */
interface Props {
  children?: unknown;
  /** Base UI's `render` prop: the element a component renders as. */
  render?: unknown;
  [prop: string]: unknown;
}

/** A React element as the payload writes it: `["$", type, key, props]`. */
type Element = ['$', string, unknown, Props | null];

const isElement = (node: unknown): node is Element =>
  Array.isArray(node) && node[0] === '$' && node.length === 4 && typeof node[1] === 'string';

const ROW_REF_RE = /^\$L?([0-9a-f]+)$/;

/** A child that stands for another row (`$<id>` or `$L<id>`) replaced by that row's value. */
function deref(flight: Flight, node: unknown): unknown {
  for (let hops = 0; typeof node === 'string' && hops < 100; hops++) {
    const ref = ROW_REF_RE.exec(node);
    if (!ref) return node;
    node = rowValue(flight, ref[1] as string);
  }
  return node;
}

/** Every element in a value, depth first, through row references. */
function* elements(flight: Flight, node: unknown, seen = new Set<unknown>()): Generator<Element> {
  node = deref(flight, node);
  if (node === null || typeof node !== 'object' || seen.has(node)) return;
  seen.add(node);
  if (isElement(node)) yield node;
  for (const value of Array.isArray(node) ? node : Object.values(node)) {
    yield* elements(flight, value, seen);
  }
}

/** An element's children, flattened, with row references resolved. */
function children(flight: Flight, node: unknown): unknown[] {
  const value = deref(flight, node);
  if (Array.isArray(value) && !isElement(value)) return value.flatMap((c) => children(flight, c));
  return value === undefined || value === null ? [] : [value];
}

/** The visible text of a value: strings, through elements' children and `render` element. */
function textOf(flight: Flight, node: unknown): string {
  return children(flight, node)
    .map((child) => {
      if (typeof child === 'string') {
        if (child.startsWith('$$')) return child.slice(1);
        return child.startsWith('$') ? '' : child; // `$undefined`, or a reference
      }
      if (typeof child === 'number') return String(child);
      if (!isElement(child)) return '';
      return textOf(flight, child[3]?.children) + textOf(flight, child[3]?.render);
    })
    .join('');
}

/**
 * The content of the collapsible whose trigger's text starts with `label`: the children of
 * the `CollapsibleContent` beside a `CollapsibleTrigger`, inside a `Collapsible`. Base UI's
 * trigger renders its `render` element (the button), so the label is read from there as
 * well as from its children. Throws unless exactly one collapsible matches.
 */
export function collapsibleContent(flight: Flight, label: string): unknown {
  const found: unknown[] = [];
  // One `seen` for every row, so an element reached from another row is counted once.
  const seen = new Set<unknown>();
  for (const id of flight.keys()) {
    for (const el of elements(flight, rowValue(flight, id), seen)) {
      if (!el[1].startsWith('$L') || clientName(flight, el[1]) !== 'Collapsible') continue;
      const parts = children(flight, el[3]?.children).filter(isElement);
      const part = (name: string) => parts.find((p) => clientName(flight, p[1]) === name);
      const trigger = part('CollapsibleTrigger');
      const content = part('CollapsibleContent');
      if (trigger && content && clean(textOf(flight, [trigger])).startsWith(label)) {
        found.push(content[3]?.children);
      }
    }
  }
  if (found.length !== 1) {
    throw new Error(
      found.length === 0
        ? `rules panel "${label}": no collapsible with that trigger label in the page's RSC payload`
        : `rules panel "${label}": ${found.length} collapsibles with that trigger label in the page's RSC payload`,
    );
  }
  return found[0];
}

const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'source',
  'track',
  'wbr',
]);
const ATTRIBUTE_NAMES: Record<string, string> = { className: 'class', htmlFor: 'for' };
const escapeText = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escapeAttr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

/**
 * The value of the row a `$<id>` or `$L<id>` reference names. Throws if the row holds no
 * value: missing (a stream cut short), an `E` error row, or an `I` component row. Rendered
 * as nothing, it would drop the panel's text without a word.
 */
function resolveRef(flight: Flight, ref: string, where: string): unknown {
  const id = ROW_REF_RE.exec(ref)?.[1] as string;
  const value = rowValue(flight, id);
  if (value === undefined) {
    throw new Error(`${where}: "${ref}" refers to row ${id}, which holds no value`);
  }
  return value;
}

/**
 * An element's props as HTML attributes: strings, numbers and `true`. Other values, and
 * props that are references other than to a row (an action such as `$h1`, `$undefined`),
 * aren't attributes and are dropped.
 */
function attributes(flight: Flight, props: Record<string, unknown>, where: string): string {
  let out = '';
  for (const [key, raw] of Object.entries(props)) {
    if (key === 'children' || key === 'key' || key === 'ref') continue;
    if (key === 'dangerouslySetInnerHTML') throw new Error(`${where}: dangerouslySetInnerHTML`);
    let value =
      typeof raw === 'string' && ROW_REF_RE.test(raw) ? resolveRef(flight, raw, where) : raw;
    if (typeof value === 'string' && value.startsWith('$')) {
      if (!value.startsWith('$$')) continue;
      value = value.slice(1);
    }
    const name = ATTRIBUTE_NAMES[key] ?? key;
    if (value === true) out += ` ${name}`;
    else if (typeof value === 'string' || typeof value === 'number')
      out += ` ${name}="${escapeAttr(String(value))}"`;
  }
  return out;
}

/**
 * Render a value from the payload as HTML: tags with their attributes, and escaped text.
 * `where` names it in errors. A client component inside it throws, since what it renders
 * isn't in the payload, and so does any `$` reference this decoder doesn't know, or a row
 * reference to a row that holds no value.
 */
export function renderHtml(flight: Flight, node: unknown, where: string): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'number') return String(node);
  if (typeof node === 'string') {
    if (node.startsWith('$$')) return escapeText(node.slice(1));
    if (node === '$undefined') return '';
    if (ROW_REF_RE.test(node)) return renderHtml(flight, resolveRef(flight, node, where), where);
    if (node.startsWith('$'))
      throw new Error(`${where}: an RSC reference it can't render, "${node}"`);
    return escapeText(node);
  }
  if (isElement(node)) {
    const [, type, , props] = node;
    if (type.startsWith('$')) {
      const name = clientName(flight, type) ?? type;
      throw new Error(`${where}: a component, "${name}", which plain HTTP can't render`);
    }
    const attrs = attributes(flight, props ?? {}, where);
    if (VOID.has(type)) return `<${type}${attrs}>`;
    return `<${type}${attrs}>${renderHtml(flight, props?.children, where)}</${type}>`;
  }
  if (Array.isArray(node)) return node.map((child) => renderHtml(flight, child, where)).join('');
  throw new Error(`${where}: a value it can't render, ${JSON.stringify(node).slice(0, 80)}`);
}
