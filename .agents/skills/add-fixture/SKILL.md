---
name: add-fixture
description: "Use when a parser bug or a page structure only shows up on a faction the saved fixtures don't cover, or when a parser change needs fixture evidence for markup no saved page has yet. Adds one saved faction page under test/fixtures/ with focused assertions, without overwriting the existing fixtures."
---

# Add a faction fixture

Factions are discovered automatically from the index page, so a **new faction needs no
code**: the next `pnpm scrape` picks it up. This skill is for when you want test
coverage of a faction whose layout differs from Necrons (the default fixture).

## When you need it
- A faction uses a structure the existing fixtures don't exercise (unusual pricing tiers,
  no detachments, special characters in names).
- A parser bug only reproduces on a specific faction.
- You are about to handle a markup variant in `src/parse/`. A fixture must show it
  first: handling for markup no fixture shows is how #18 had to be reverted in #19.

## Steps
1. Add the fixture download to `FIXTURES` in `src/fixtures.ts`, with a comment
   saying which case it covers:
   ```ts
   // orks: a detachment granting two Force Dispositions ("War Horde").
   { name: 'orks.html', url: factionUrl('orks') },
   ```
   The scrape fetches every faction page with the Legends cookie; for a page as it sees
   it, Legends included, add `cookie: LEGENDS_COOKIE` (as `necrons-legends-cookie.html`
   does).
2. Download just that one, so no existing fixture changes:
   ```bash
   pnpm refresh-fixtures --only orks.html
   git status test/fixtures        # exactly one new file
   ```
   Without `--only` the script overwrites every fixture. Some pin cases the live site no
   longer shows (`adepta-sororitas.html` holds the "changed since the last MFM" layer), so
   never commit a refresh of the existing ones as a side effect.
3. Add focused assertions in `test/parse.test.ts` for the structure you care about
   (mirror the Necrons `describe` block). Add a `toMatchSnapshot()` if useful.
4. `pnpm test -u` to baseline, then review the snapshot diff before committing. The
   existing fixtures' snapshots must not change.

## Keep it lean
Fixtures pin behaviour; they are not a mirror of the site. Add one only when it covers a
genuinely new structural case. Note in the PR what case the new fixture exercises.
