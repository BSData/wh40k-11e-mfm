# Playbook: Add or update a faction fixture

Factions are discovered automatically from the index page, so a **new faction needs no
code** — the next `pnpm scrape` picks it up. This playbook is for when you want test
coverage of a faction whose layout differs from Necrons (the default fixture).

## When you need it
- A faction uses a structure the Necrons fixture doesn't exercise (unusual pricing tiers,
  no detachments, special characters in names).
- A parser bug only reproduces on a specific faction.

## Steps
1. Add the fixture download to `FIXTURES` in `scripts/refresh-fixtures.ts`:
   ```ts
   { name: 'orks.html', url: factionUrl('orks') },
   ```
2. Download it: `pnpm refresh-fixtures`.
3. Add focused assertions in `test/parse.test.ts` for the structure you care about
   (mirror the Necrons `describe` block). Add a `toMatchSnapshot()` if useful.
4. `pnpm test -u` to baseline, then review the snapshot diff before committing.

## Keep it lean
Fixtures pin behaviour; they are not a mirror of the site. Add one only when it covers a
genuinely new structural case. Note in the PR what case the new fixture exercises.
