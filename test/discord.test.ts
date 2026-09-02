import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { announcement, type DiscordMessage, send, webhookUrl } from '../src/discord.js';
import type { FactionContent } from '../src/model.js';
import { parseFaction } from '../src/parse.js';

const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), 'utf8');

const parsedNecrons = parseFaction(fixture('necrons.html'), 'necrons', 'Necrons');
const necrons = (): FactionContent => structuredClone(parsedNecrons);

/** A copy of the fixture under a different name, so change sets can span factions. */
const as = (name: string, slug = name.toLowerCase().replace(/\W+/g, '-')): FactionContent => ({
  ...necrons(),
  slug,
  name,
});

/** Move a faction's first unit cost by `delta` points. */
function reprice(f: FactionContent, delta: number, unit = 'Necron Warriors'): FactionContent {
  const cost = f.units.find((u) => u.name === unit)?.pricing[0]?.costs[0];
  if (!cost) throw new Error(`no cost row for ${unit}`);
  cost.points += delta;
  return f;
}

/** Move the first cost of the first `count` units — a faction with `count` units moved. */
function repriceUnits(f: FactionContent, count: number, delta = 5): FactionContent {
  for (const u of f.units.slice(0, count)) {
    const cost = u.pricing[0]?.costs[0];
    if (!cost) throw new Error(`no cost row for ${u.name}`);
    cost.points += delta;
  }
  return f;
}

/** The rows of a monospace block field, without its fences. */
const blockRows = (value: string | undefined) =>
  (value ?? '').split('\n').filter((l) => l !== '```');

const embedOf = (m: ReturnType<typeof announcement>) => {
  if (!m) throw new Error('expected an announcement');
  return m.embeds[0];
};

describe('announcement', () => {
  it('is null when nothing changed — silence, not "no changes"', () => {
    expect(announcement([necrons()], [necrons()])).toBeNull();
  });

  it('names the single faction that changed, with its totals', () => {
    const e = embedOf(announcement([necrons()], [reprice(necrons(), 10)], { today: '2026-08-31' }));
    expect(e.title).toBe('MFM v1.1 update — 2026-08-31');
    expect(e.description).toContain('**Necrons** changed');
    expect(e.description).toContain('**1 point change**');
    expect(e.description).toContain('▲1 raised · ▼0 cut');
    // Net points is deliberately absent: summing deltas over unrelated units is noise.
    expect(e.description).not.toMatch(/net [+-]/);
  });

  it('ranks factions by how much of them moved, not by points', () => {
    const before = [as('Orks'), as('Necrons', 'necrons'), as('Aeldari')];
    const after = [
      repriceUnits(as('Orks'), 2),
      // A big single swing on one unit must not outrank a faction with more units moved.
      reprice(as('Necrons', 'necrons'), -400),
      repriceUnits(as('Aeldari'), 5),
    ];
    const moved = embedOf(announcement(before, after, { today: '2026-08-31' })).fields[0];
    expect(moved?.name).toBe('Units / detachments changed');
    const rows = blockRows(moved?.value);
    expect(rows.map((r) => r.trim().split(/\s{2,}/)[0])).toEqual(['Aeldari', 'Orks', 'Necrons']);
    // Counts are columned, and a faction with no detachment change shows a dash.
    expect(moved?.value).toContain('Aeldari  5  -');
  });

  it('lists every faction that moved, and names the swept-up ones apart', () => {
    const names = Array.from({ length: 5 }, (_, i) => `Faction ${i}`);
    const before = names.map((n) => as(n));
    // Three factions actually move; two only carry the revision's version bump.
    const after = names.map((n, i) =>
      i < 3 ? repriceUnits(as(n), i + 1) : { ...as(n), version: '1.2' },
    );
    const fields = embedOf(announcement(before, after, { today: '2026-08-31' })).fields;
    expect(blockRows(fields[0]?.value)).toHaveLength(3);
    expect(fields[1]?.name).toBe('No unit or detachment changes');
    expect(fields[1]?.value).toBe('Faction 3, Faction 4');
  });

  it('hoists a version bump every faction shares, and names new and removed ones', () => {
    const before = [as('Orks'), as('Aeldari')];
    const after = [as('Orks'), as('Aeldari')].map((f) => ({ ...f, version: '1.2' }));
    expect(embedOf(announcement(before, after, { today: '2026-08-31' })).description).toContain(
      'all v1.1 → v1.2',
    );

    const churned = embedOf(
      announcement([as('Orks')], [as('Aeldari')], { today: '2026-08-31' }),
    ).description;
    expect(churned).toContain('🆕 1 new');
    expect(churned).toContain('🗑 1 removed');
  });

  it('points "full changelog" at the PR, not at a branch that lacks the update yet', () => {
    const e = embedOf(
      announcement([as('Orks')], [reprice(as('Orks'), 15)], {
        today: '2026-08-31',
        prNumber: 41,
        prUrl: 'https://example.invalid/pull/41',
        changelogUrl: 'https://example.invalid/main/CHANGELOG.md',
      }),
    );
    expect(e.url).toBe('https://example.invalid/pull/41');
    expect(e.description).toContain('[Full changelog · PR #41](https://example.invalid/pull/41)');
    // main's changelog does not carry this update at announce time, so it isn't linked.
    expect(e.description).not.toContain('main/CHANGELOG.md');
  });

  it('falls back to the changelog link when there is no PR', () => {
    const e = embedOf(
      announcement([as('Orks')], [reprice(as('Orks'), 15)], {
        today: '2026-08-31',
        changelogUrl: 'https://example.invalid/CHANGELOG.md',
      }),
    );
    expect(e.description).toContain('[Full changelog](https://example.invalid/CHANGELOG.md)');
  });

  it('counts a unit whose pricing was re-tiered, without calling it an add or a remove', () => {
    const before = as('Orks');
    const after = as('Orks');
    const warriors = after.units.find((u) => u.name === 'Necron Warriors');
    const base = warriors?.pricing[0];
    if (!warriors || !base) throw new Error('fixture changed');
    // GW's v1.3 move: one tier becomes a 1st–2nd / 3rd+ requisition pair.
    warriors.pricing = [
      { ...base, range: '[1,2]', label: 'Your 1st To 2nd Units Cost' },
      {
        ...base,
        range: '[3,)',
        label: 'Your 3rd + Units Cost',
        costs: base.costs.map((c) => ({ ...c, points: c.points + 30 })),
      },
    ];
    const e = embedOf(announcement([before], [after], { today: '2026-08-31' }));
    expect(e.description).toContain('1 unit re-tiered');
    expect(e.description).toContain('Units: 1 changed');
    // The unit was neither added nor removed, so those counts stay clear of it.
    expect(e.description).not.toContain('added');
    expect(e.description).not.toContain('removed');
  });

  it('stays inside every Discord limit on an outsized update', () => {
    // 40 factions with names far longer than any real one, all moving a lot of points —
    // long enough that both the swings block and the name list have to give ground.
    const names = Array.from({ length: 40 }, (_, i) => `${'Faction'.repeat(16)} ${i}`);
    const before = names.map((n, i) => as(n, `f${i}`));
    const after = names.map((n, i) => reprice(as(n, `f${i}`), (i + 1) * 7));
    const e = embedOf(announcement(before, after, { today: '2026-08-31' }));

    expect(e.title.length).toBeLessThanOrEqual(256);
    expect(e.description.length).toBeLessThanOrEqual(4096);
    for (const f of e.fields) expect(f.value.length).toBeLessThanOrEqual(1024);
    const total =
      e.title.length +
      e.description.length +
      e.footer.text.length +
      e.fields.reduce((n, f) => n + f.name.length + f.value.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    // The block gave up rows to stay under its own limit, rather than being cut mid-line
    // into a broken fence — and says so, so the reader knows the list is partial.
    const rows = e.fields[0]?.value.split('\n') ?? [];
    expect(rows.at(0)).toBe('```');
    expect(rows.at(-1)).toBe('```');
    expect(blockRows(e.fields[0]?.value).length).toBeLessThan(40);
    expect(e.fields[0]?.value).toMatch(/…and \d+ more\n```$/);
  });

  it('never lets a faction name become a ping', () => {
    const shouty = as('@everyone');
    const message = announcement([as('@everyone')], [reprice(shouty, 5)], { today: '2026-08-31' });
    expect(message?.allowed_mentions).toEqual({ parse: [] });
  });

  it('is dated from the data, so re-rendering an unchanged update repeats byte for byte', () => {
    const before = [{ ...necrons(), firstSeen: '2026-06-17' }];
    const after = [{ ...reprice(necrons(), 10), firstSeen: '2026-08-31' }];
    const first = announcement(before, after, { today: '2026-08-31' });
    // A later run of the same unchanged update must produce the same message to edit with.
    expect(announcement(before, after, { today: '2026-09-04' })).toEqual(first);
    expect(embedOf(first).timestamp).toBe('2026-08-31T00:00:00.000Z');
  });
});

/** A request the stub Discord recorded, so a test can assert what was actually sent. */
interface Call {
  method: string;
  path: string;
  body: string;
}

/**
 * A stand-in for Discord's webhook API. `send()` takes an already-validated base URL
 * precisely so it can be pointed here — the code under test is the code that ships,
 * rather than a copy of it living somewhere untestable.
 */
async function stubDiscord(
  reply: (call: Call) => { status: number; body?: string },
): Promise<{ hook: string; calls: Call[]; server: Server }> {
  const calls: Call[] = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      const call = { method: req.method ?? '', path: req.url ?? '', body };
      calls.push(call);
      const { status, body: out } = reply(call);
      res.writeHead(status, { 'content-type': 'application/json' }).end(out ?? '{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { hook: `http://127.0.0.1:${port}/api/webhooks/1/token`, calls, server };
}

let running: Server | undefined;
afterEach(async () => {
  if (running) await new Promise((resolve) => running?.close(resolve));
  running = undefined;
});

const payload: DiscordMessage = {
  embeds: [
    {
      title: 'MFM v1.3 update — 2026-08-26',
      url: 'https://example.invalid',
      description: 'test',
      color: 0,
      fields: [],
      footer: { text: 'test' },
      timestamp: '2026-08-26T00:00:00.000Z',
    },
  ],
  allowed_mentions: { parse: [] },
};

describe('send', () => {
  it('posts when the update has no message yet, and returns the id and permalink', async () => {
    const stub = await stubDiscord((call) =>
      call.method === 'GET'
        ? { status: 200, body: '{"guild_id":"77","channel_id":"88"}' }
        : { status: 200, body: '{"id":"999","channel_id":"88"}' },
    );
    running = stub.server;

    await expect(send(stub.hook, payload)).resolves.toEqual({
      id: '999',
      url: 'https://discord.com/channels/77/88/999',
    });
    const post = stub.calls.find((c) => c.method === 'POST');
    // wait=true is what makes Discord return the id at all.
    expect(post?.path).toContain('wait=true');
    expect(JSON.parse(post?.body ?? '{}')).toEqual(payload);
  });

  it('still reports the message when the permalink cannot be resolved', async () => {
    // The guild is only on the webhook object; without it there is no link to build.
    const stub = await stubDiscord((call) =>
      call.method === 'GET'
        ? { status: 403, body: '{"message":"Missing Access"}' }
        : { status: 200, body: '{"id":"999"}' },
    );
    running = stub.server;

    // The announcement matters more than its link, so the id still comes back.
    await expect(send(stub.hook, payload)).resolves.toEqual({ id: '999' });
  });

  it('edits the existing message on a later day, and records nothing new', async () => {
    const stub = await stubDiscord(() => ({ status: 200, body: '{"id":"999"}' }));
    running = stub.server;

    await expect(send(stub.hook, payload, '999')).resolves.toBeUndefined();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]?.method).toBe('PATCH');
    expect(stub.calls[0]?.path).toBe('/api/webhooks/1/token/messages/999');
  });

  it('falls back to posting when the recorded message is gone', async () => {
    const stub = await stubDiscord((call) =>
      call.method === 'PATCH'
        ? { status: 404, body: '{"message":"Unknown Message"}' }
        : { status: 200, body: '{"id":"1000"}' },
    );
    running = stub.server;

    // The announcement survives a message someone deleted in Discord.
    await expect(send(stub.hook, payload, '555')).resolves.toMatchObject({ id: '1000' });
    expect(stub.calls.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual([
      'PATCH',
      'POST',
    ]);
  });

  it('throws when Discord rejects the post, rather than reporting success', async () => {
    const stub = await stubDiscord(() => ({
      status: 400,
      body: '{"message":"Invalid Form Body"}',
    }));
    running = stub.server;

    await expect(send(stub.hook, payload)).rejects.toThrow(/HTTP 400/);
  });
});

describe('webhookUrl', () => {
  it('accepts Discord webhooks and trims a trailing slash', () => {
    expect(webhookUrl('https://discord.com/api/webhooks/1/abc')).toBe(
      'https://discord.com/api/webhooks/1/abc',
    );
    expect(webhookUrl('https://discord.com/api/webhooks/1/abc/')).toBe(
      'https://discord.com/api/webhooks/1/abc',
    );
    expect(webhookUrl('https://discordapp.com/api/webhooks/1/abc')).toBe(
      'https://discordapp.com/api/webhooks/1/abc',
    );
  });

  it('refuses anything else, so a mis-set secret cannot exfiltrate the summary', () => {
    for (const bad of [
      'http://discord.com/api/webhooks/1/abc', // plaintext
      'https://example.invalid/api/webhooks/1/abc', // wrong host
      'https://discord.com.example.invalid/api/webhooks/1/abc', // lookalike host
      'https://discord.com/api/oauth2/authorize', // right host, wrong endpoint
    ]) {
      expect(() => webhookUrl(bad)).toThrow(/not a Discord webhook URL/);
    }
  });
});
