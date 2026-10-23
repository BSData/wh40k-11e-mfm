import { describe, expect, it } from 'vitest';
import { RULES_PANELS, rulesPanels } from '../src/parse/panels.js';
import { collapsibleContent, readFlight, renderHtml } from '../src/parse/rsc.js';

// The RSC payload decoder on small hand-written payloads, in the shapes the saved pages
// show (test/fixtures/necrons-panels-rsc.html): client references in `I` rows, elements as
// ["$", type, key, props], `$<id>`/`$L<id>` row references and `T` text rows.

/** A page carrying `rows` as its payload, split over two pushes as Next.js streams it. */
function page(...rows: string[]): string {
  const flight = rows.join('');
  const half = Math.floor(flight.length / 2);
  return [flight.slice(0, half), flight.slice(half)]
    .map((part) => `<script>self.__next_f.push([1,${JSON.stringify(part)}])</script>`)
    .join('');
}

/** A JSON row. */
const row = (id: string, value: unknown) => `${id}:${JSON.stringify(value)}\n`;

/** A `T` row: its length is in UTF-8 bytes, and no newline ends it. */
const textRow = (id: string, text: string) =>
  `${id}:T${Buffer.byteLength(text).toString(16)},${text}`;

const COMPONENTS = [
  '1:I[10,[],"Collapsible"]\n',
  '2:I[10,[],"CollapsibleTrigger"]\n',
  '3:I[10,[],"CollapsibleContent"]\n',
  '4:I[11,[],"Button"]\n',
  '5:I[12,[],"Link"]\n',
];

/** A collapsible whose trigger is a button labelled `label`, holding `content`. */
const collapsible = (label: string, content: unknown) => [
  '$',
  '$L1',
  null,
  {
    children: [
      [
        '$',
        '$L2',
        null,
        { render: ['$', '$L4', null, { children: [['$', 'b', null, { children: label }]] }] },
      ],
      ['$', '$L3', null, { children: content }],
    ],
  },
];

const panel = (rows: string[], label = 'Muster Armies') => {
  const flight = readFlight(page(...COMPONENTS, ...rows));
  return renderHtml(flight, collapsibleContent(flight, label), 'the panel');
};

describe('the RSC payload decoder (src/parse/rsc.ts)', () => {
  it('finds a collapsible by its trigger label and renders its content, through row references', () => {
    const content = ['$', 'div', null, { className: 'flex', children: ['$L7', '$8'] }];
    expect(
      panel([
        row('6', collapsible('Muster Armies', content)),
        row('7', ['$', 'p', 'p0', { children: ['a ', ['$', 'b', null, { children: '$$5 off' }]] }]),
        textRow('8', 'Café — 💀 & <more>'),
      ]),
    ).toBe('<div class="flex"><p>a <b>$5 off</b></p>Café — 💀 &amp; &lt;more&gt;</div>');
  });

  it('reads a T row by its UTF-8 byte length, so the next row still parses', () => {
    const flight = readFlight(page(textRow('a', 'é💀\nline'), row('b', 'after')));
    expect(renderHtml(flight, '$a', 'x')).toBe('é💀\nline');
    expect(renderHtml(flight, '$b', 'x')).toBe('after');
  });

  it('renders string, number and true props as attributes, and drops references', () => {
    const link = [
      '$',
      'a',
      null,
      { href: '/en/rules', colSpan: 2, hidden: true, onClick: '$h1', children: 'x' },
    ];
    expect(panel([row('6', collapsible('Muster Armies', link))])).toBe(
      '<a href="/en/rules" colSpan="2" hidden>x</a>',
    );
  });

  it('matches the label at the start of the trigger text, and not elsewhere', () => {
    const rows = [
      row('6', collapsible('Welcome to the Munitorum Field Manual, containing…', 'hi')),
    ];
    expect(panel(rows, 'Welcome to the Munitorum Field Manual')).toBe('hi');
    expect(() => panel(rows, 'Munitorum Field Manual')).toThrow(
      'rules panel "Munitorum Field Manual": no collapsible with that trigger label',
    );
  });

  it('fails when two collapsibles have the label', () => {
    expect(() =>
      panel([row('6', [collapsible('Muster Armies', 'a'), collapsible('Muster Armies', 'b')])]),
    ).toThrow('rules panel "Muster Armies": 2 collapsibles with that trigger label');
  });

  it('counts a collapsible reached from another row once', () => {
    expect(
      panel([
        row('6', collapsible('Muster Armies', 'once')),
        row('7', ['$', 'div', null, { children: '$6' }]),
      ]),
    ).toBe('once');
  });

  it('fails on a component inside the panel, which plain HTTP cannot render', () => {
    const content = [
      '$',
      'p',
      null,
      { children: ['$', '$L5', null, { href: '/x', children: 'rules' }] },
    ];
    expect(() => panel([row('6', collapsible('Muster Armies', content))])).toThrow(
      'the panel: a component, "Link", which plain HTTP can\'t render',
    );
  });

  it('fails on a reference it does not know, and on raw HTML', () => {
    expect(() => panel([row('6', collapsible('Muster Armies', ['text', '$@3']))])).toThrow(
      'the panel: an RSC reference it can\'t render, "$@3"',
    );
    const raw = ['$', 'div', null, { dangerouslySetInnerHTML: { __html: '<b>x</b>' } }];
    expect(() => panel([row('6', collapsible('Muster Armies', raw))])).toThrow(
      'the panel: dangerouslySetInnerHTML',
    );
  });

  it.each([
    ['a row the stream never sent', '$L99', []],
    ['an E (error) row', '$7', ['7:E{"digest":"boom"}\n']],
    ['an I (component) row', '$1', []],
  ])('fails on a reference to %s, rather than dropping the text', (_what, ref, rows) => {
    const content = ['before ', ref, ' after'];
    expect(() => panel([row('6', collapsible('Muster Armies', content)), ...rows])).toThrow(
      `the panel: "${ref}" refers to row ${ref.replace(/^\$L?/, '')}, which holds no value`,
    );
    // In a prop too: the attribute would be lost.
    const link = ['$', 'a', null, { href: ref, children: 'x' }];
    expect(() => panel([row('6', collapsible('Muster Armies', link)), ...rows])).toThrow(
      'which holds no value',
    );
  });

  it('names a component by its own row, not a neighbour', () => {
    const content = ['$', '$12', null, { children: 'x' }];
    expect(() => panel([row('6', collapsible('Muster Armies', content))])).toThrow(
      'the panel: a component, "$12"',
    );
  });

  it('renders $undefined, null and booleans as nothing', () => {
    expect(
      panel([row('6', collapsible('Muster Armies', ['a', '$undefined', null, false, 'b']))]),
    ).toBe('ab');
  });
});

describe('rulesPanels on a hand-written payload', () => {
  const both = (notes: unknown, muster: unknown) =>
    page(
      ...COMPONENTS,
      row('6', [collapsible(RULES_PANELS.notes, notes), collapsible(RULES_PANELS.muster, muster)]),
    );

  it('converts each panel to Markdown', () => {
    const notes = ['$', 'div', null, { children: [['$', 'b', null, { children: 'UNITS' }]] }];
    expect(rulesPanels(both(notes, 'Bring an army.'))).toEqual({
      notes: '## UNITS',
      muster: 'Bring an army.',
    });
  });

  it('fails a panel with no text', () => {
    expect(() => rulesPanels(both('Read this.', ['$', 'div', null, { children: ' ' }]))).toThrow(
      'rules panel "Muster Armies" has no text',
    );
  });
});
