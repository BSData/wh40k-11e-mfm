# 0021. Names match the official ones

- **Status:** accepted, [#88](https://github.com/BSData/wh40k-11e-mfm/pull/88)
- **Spec:** [data model — Names](../../specs/data-model.md#names)

## Context
The site writes names in ALL CAPS, and the scraper Title-Cased them by capitalising after
every space, apostrophe, `(` and `-`. That gave `Emperor’S Champion`, `‘iron Hand’
Straken`, `Anrakyr The Traveller` and `ûthar The Destined`. At least three consumers wrote
their own normalisation to cope. Of 1,500 distinct names, 1,222 matched the spelling in
the [BSData/wh40k-11e](https://github.com/BSData/wh40k-11e) catalogues, which is the
reference the community already uses.

## Decision
- Names follow one rule, close to how titles are usually cased: a capital at the start of
  each word and each part of a hyphenated word, also after an opening quote; none after
  an apostrophe inside a word; the small words lower-case unless the name starts with one.
- The words no rule can give (`El’Jonson`, and initialisms such as `RSV`) are listed in
  `OFFICIAL_SPELLINGS`, rather than taken from the catalogues at run time: the scraper
  stays offline and deterministic.
- The site's own characters stay, so `name.toUpperCase()` gives back the page's text.
  It's the stable key across this change, and any later one.
- Tier labels keep every word capitalised (`Your 1st To 2nd Units Cost`). They aren't
  names, and nothing matches them against anything.
- Renaming isn't new MFM content, so it must not move `firstSeen`. `mfm scrape
  --ignore-name-case` compares content with names upper-cased, so only the case of names
  is ignored; a real change found by the same run still gets the run date.

## Consequences
- 1,444 of the 1,500 names match the catalogues. None of the rest is a casing the rule
  could get right:
  - 27 have no catalogue entry under the same wording: sub-group titles, names worded
    differently (`Haloscreed Battle Clade`, `Sentry Pylons`), units the catalogue lacks.
  - 21 differ after a hyphen. The catalogues lower-case some (`Caladius Grav-tank`,
    `Foetid Bloat-drone`) and capitalise 28 others (`Shield-Captain`, `Tech-Priest
    Dominus`), some both ways. Capitalising matches more.
  - 8 differ after `with`, where some catalogue entries lower-case the wargear (`Daemon
    Prince of Nurgle with wings`) and others don't (`Sanguinary Priest with Jump Pack`).
- Following the catalogues is deliberate where other sources write a capital after the
  apostrophe: `Aun’va`, `Aun’shi`, `Syll’esske`, `Shas’o R’alai`.
- A change to the rule regenerates `data/` in the same PR: a test checks every committed
  name against it. It should merge while no update PR is open, so the renames don't land
  in an MFM update's changelog.
