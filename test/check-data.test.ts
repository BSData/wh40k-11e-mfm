import { describe, expect, it } from 'vitest';
import { checkData, type GeneratedFiles } from '../scripts/check-data.js';
import { changelogIndex, withEntry } from '../src/changelog.js';
import { factionToYaml, metaFromYaml, metaToYaml } from '../src/emit.js';
import type { Faction } from '../src/model.js';

const necrons: Faction = {
  name: 'Necrons',
  slug: 'necrons',
  version: '1.6',
  firstSeen: '2026-10-14',
  detachments: [
    {
      name: 'Awakened Dynasty',
      dp: 2,
      objectives: ['TAKE AND HOLD'],
      enhancements: [{ name: 'Phylactery', points: 20 }],
    },
  ],
  units: [
    {
      name: 'Necron Warriors',
      pricing: [{ range: '[1,)', label: 'Your Unit Costs', costs: [{ models: 10, points: 80 }] }],
    },
    {
      name: 'Overlord',
      pricing: [{ range: '[1,)', label: 'Your Unit Costs', costs: [{ models: 1, points: 85 }] }],
    },
  ],
};

const meta = { version: '1.6', lastUpdated: '2026-10-14', factions: ['necrons'] };

const v16 = {
  name: 'v1.6.md',
  text: withEntry(undefined, '1.6', '## [2026-10-14] — MFM v1.6\n\n**1 faction changed**\n'),
};

/** A consistent set of generated files, as the scraper and the changelog script write them. */
const files = (): GeneratedFiles => ({
  data: [
    { name: 'meta.yaml', text: metaToYaml(meta) },
    { name: 'necrons.yaml', text: factionToYaml(necrons) },
  ],
  changelog: [v16],
  index: changelogIndex([v16]),
});

/** `files()` with one data file's text replaced. */
const withData = (name: string, text: string): GeneratedFiles => {
  const f = files();
  f.data = f.data.map((d) => (d.name === name ? { name, text } : d));
  return f;
};

describe('checkData', () => {
  it('passes files exactly as the tools write them', () => {
    expect(checkData(files())).toEqual([]);
  });

  describe('fails on a data file that is not canonical', () => {
    const yaml = factionToYaml(necrons);
    it.each([
      [
        'entries out of order',
        factionToYaml({ ...necrons, units: [...necrons.units].reverse() }, 'page'),
      ],
      ['an unknown key', `${yaml}source: hand-edited\n`],
      [
        'a block-style cost',
        yaml.replace('- { models: 10, points: 80 }', '- models: 10\n            points: 80'),
      ],
      ['a comment', yaml.replace('units:\n', 'units: # hand-edited\n')],
      ['CRLF line endings', yaml.replaceAll('\n', '\r\n')],
      ['no final newline', yaml.trimEnd()],
    ])('%s', (_, text) => {
      expect(text).not.toBe(yaml);
      const [problem, ...rest] = checkData(withData('necrons.yaml', text));
      expect(rest).toEqual([]);
      expect(problem).toMatch(/^data\/necrons\.yaml is not canonical: (line \d+ is |only )/);
      expect(problem).toContain('factionToYaml()');
    });

    it('meta.yaml with its factions unsorted', () => {
      const text = metaToYaml(meta).replace('  - necrons\n', '  - orks\n  - necrons\n');
      expect(checkData(withData('meta.yaml', text))).toEqual([
        'data/meta.yaml is not canonical: line 4 is "  - orks" where metaToYaml() writes "  - necrons"',
      ]);
    });
  });

  describe('fails on a schema violation', () => {
    it('a negative points value in a faction', () => {
      const text = factionToYaml(necrons).replace('points: 85', 'points: -85');
      const [problem, ...rest] = checkData(withData('necrons.yaml', text));
      expect(rest).toEqual([]);
      expect(problem).toMatch(/^data\/necrons\.yaml is invalid:\n/);
      expect(problem).toContain('units[1].pricing[0].costs[0].points');
    });

    it('a faction whose version lost its quotes', () => {
      const text = factionToYaml(necrons).replace('version: "1.6"', 'version: 1.6');
      expect(checkData(withData('necrons.yaml', text))[0]).toContain('version');
    });

    it('a YAML syntax error, reported rather than thrown', () => {
      const [problem] = checkData(withData('necrons.yaml', 'units: [\n'));
      expect(problem).toMatch(/^data\/necrons\.yaml is invalid:\n/);
    });

    it('meta.yaml without a valid lastUpdated date', () => {
      const text = metaToYaml(meta).replace('lastUpdated: 2026-10-14', 'lastUpdated: yesterday');
      const [problem, ...rest] = checkData(withData('meta.yaml', text));
      expect(rest).toEqual([]);
      expect(problem).toMatch(/^data\/meta\.yaml is invalid:\n/);
      expect(problem).toContain('lastUpdated');
    });

    it('a missing meta.yaml', () => {
      const f = files();
      f.data = f.data.filter((d) => d.name !== 'meta.yaml');
      expect(checkData(f)).toEqual(['data/meta.yaml is missing']);
    });

    it('a faction file not named after its slug', () => {
      const f = files();
      f.data.push({ name: 'orks.yaml', text: factionToYaml(necrons) });
      expect(checkData(f)).toEqual([
        'data/orks.yaml holds the slug "necrons", so it belongs in data/necrons.yaml',
      ]);
    });
  });

  describe('fails on a stale DATA-CHANGELOG.md', () => {
    it('a version file added without regenerating the index', () => {
      const f = files();
      f.changelog.push({
        name: 'v1.7.md',
        text: withEntry(undefined, '1.7', '## [2026-11-01] — MFM v1.7\n\n**1 faction changed**\n'),
      });
      const [problem, ...rest] = checkData(f);
      expect(rest).toEqual([]);
      expect(problem).toMatch(/^DATA-CHANGELOG\.md is out of date with changelog\/: line \d+ is /);
      expect(problem).toContain('[MFM v1.7](changelog/v1.7.md)');
    });

    it('a hand-edited index', () => {
      const f = files();
      f.index = `${f.index}- [MFM v1.5](changelog/v1.5.md) — 2026-09-30\n`;
      expect(checkData(f)).toEqual([
        'DATA-CHANGELOG.md is out of date with changelog/: line 12 is "- [MFM v1.5](changelog/v1.5.md) — 2026-09-30" where changelogIndex() writes the end of the file',
      ]);
    });

    it('a missing index', () => {
      expect(checkData({ ...files(), index: undefined })).toEqual(['DATA-CHANGELOG.md is missing']);
    });
  });

  it('reports every problem, not just the first', () => {
    const f = withData('necrons.yaml', `${factionToYaml(necrons)}source: hand-edited\n`);
    f.index = '';
    expect(checkData(f)).toHaveLength(2);
  });
});

describe('metaFromYaml', () => {
  it('validates against SiteMeta instead of trusting the file', () => {
    expect(metaFromYaml(metaToYaml(meta))).toEqual(meta);
    expect(() => metaFromYaml('version: "1.6"\nlastUpdated: 2026-10-14\n')).toThrow('factions');
    expect(() => metaFromYaml('lastUpdated: 2026-10-14\nfactions: [necrons]\n')).toThrow('version');
  });
});
