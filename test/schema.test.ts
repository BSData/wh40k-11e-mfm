import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { loadFactionDir } from '../src/diff.js';
import { metaFromYaml } from '../src/emit.js';
import { datasetJson } from '../src/release.js';
import { jsonSchemas } from '../src/schema.js';

/**
 * The JSON Schemas under `schema/`, checked with an off-the-shelf validator (Ajv, JSON
 * Schema draft 2020-12) rather than with zod, which they are generated from: every
 * committed data file validates against them as a consumer would read it, and they reject
 * what the model rejects. See "JSON Schema" in specs/data-model.md.
 */

const root = (path: string) => fileURLToPath(new URL(`../${path}`, import.meta.url));
const read = (path: string) => readFileSync(root(path), 'utf8');

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validator = (name: string) => ajv.compile(JSON.parse(read(`schema/${name}`)));
const faction = validator('faction.schema.json');
const meta = validator('meta.schema.json');
const all = validator('all.schema.json');

/** The validator's verdict, with its errors when it fails, so a failure says why. */
const verdict = (validate: ReturnType<typeof validator>, value: unknown) =>
  validate(value) ? 'valid' : ajv.errorsText(validate.errors);

const factionFiles = readdirSync(root('data')).filter(
  (name) => name.endsWith('.yaml') && name !== 'meta.yaml',
);

describe('the committed schemas', () => {
  it.each(jsonSchemas())('schema/$name is the one the model generates', ({ name, text }) => {
    expect(read(`schema/${name}`)).toBe(text);
  });
});

describe('every committed data file validates against its schema', () => {
  it('finds the faction files', () => {
    expect(factionFiles.length).toBeGreaterThan(20);
  });

  // Read the way a consumer reads them: the YAML as parsed, not as zod cleaned it up.
  it.each(factionFiles)('data/%s', (name) => {
    expect(verdict(faction, parse(read(`data/${name}`)))).toBe('valid');
  });

  it('data/meta.yaml', () => {
    expect(verdict(meta, parse(read('data/meta.yaml')))).toBe('valid');
  });

  it('all.json, as the release builds it from data/', () => {
    const json = datasetJson(metaFromYaml(read('data/meta.yaml')), loadFactionDir(root('data')));
    expect(verdict(all, JSON.parse(json))).toBe('valid');
  });
});

describe('the schemas reject what the model rejects', () => {
  type Json = Record<string | number, unknown>;
  /** A copy of `json` with `value` at `path`, or without the key when it is undefined. */
  function edited(json: unknown, path: (string | number)[], value: unknown): unknown {
    const copy = structuredClone(json);
    let at = copy as Json;
    for (const key of path.slice(0, -1)) at = at[key] as Json;
    const key = path.at(-1) ?? '';
    if (value === undefined) Reflect.deleteProperty(at, key);
    else at[key] = value;
    return copy;
  }
  const necrons = parse(read('data/necrons.yaml'));
  const cost = ['units', 0, 'pricing', 0, 'costs', 0];

  it.each([
    ['a negative points value', [...cost, 'points'], -5],
    ['points as a string', [...cost, 'points'], '80'],
    ['a range that is not an interval', ['units', 0, 'pricing', 0, 'range'], '1+'],
    ['a unit without pricing', ['units', 0, 'pricing'], undefined],
    ['legends: false', ['units', 0, 'legends'], false],
    ['firstSeen not a date', ['firstSeen'], 'yesterday'],
    ['detachment dp as text', ['detachments', 0, 'dp'], '2DP'],
  ] as const)('%s', (_, path, value) => {
    expect(faction(necrons)).toBe(true);
    expect(faction(edited(necrons, [...path], value))).toBe(false);
  });

  it.each([2.5, 3, '2'])('meta.yaml at schemaVersion %j', (schemaVersion) => {
    expect(meta({ ...parse(read('data/meta.yaml')), schemaVersion })).toBe(false);
  });

  it('meta.yaml without schemaVersion', () => {
    const { schemaVersion: _, ...rest } = parse(read('data/meta.yaml'));
    expect(meta(rest)).toBe(false);
  });
});

describe('a key the schema does not list', () => {
  // An optional field added later doesn't bump schemaVersion, so data that has one must
  // still validate against the schema of the version it states.
  it('is accepted, so an addition breaks no reader of an older schema', () => {
    const f = parse(read('data/necrons.yaml'));
    f.addedLater = true;
    f.units[0].addedLater = [];
    expect(verdict(faction, f)).toBe('valid');
    expect(verdict(meta, { ...parse(read('data/meta.yaml')), addedLater: 1 })).toBe('valid');
  });
});
