# 0039. A tier is read only from a tier label

- **Status:** accepted, for [#110](https://github.com/BSData/wh40k-11e-mfm/issues/110); follows [0036](0036-a-label-counts-once-with-its-block.md)
- **Spec:** [scraping — Selectors](../../specs/scraping.md#selectors-the-drift-prone-surface)

## Context
[0036](0036-a-label-counts-once-with-its-block.md) made a card a unit only if it has a
`div.bg-slate-200` whose whole text reads `YOUR … COST(S)` and whose next sibling is a
`ul.leaders`. `parseUnit` kept the looser reading for the tiers themselves: any
`div.bg-slate-200` in the card with a `ul.leaders` somewhere after it among its siblings.

The review of [#106](https://github.com/BSData/wh40k-11e-mfm/pull/106) found what that lets
through: a change note inside a tier's wrapper. A `POINTS REVISED` note put just before or
just after the `YOUR 2ND + UNIT COSTS` label of `CANOPTEK WRAITHS` in `necrons.html` gave
the unit three tiers: the two real ones, and a `Points Revised` tier with the range `[1,)`
and the second tier's costs, overlapping both. Nothing failed. The coverage check passed,
since every string had been consumed. In an update PR it would read as GW re-tiering the
unit ([0003](0003-a-re-tiering-is-a-change.md)), not as a misread.

No fixture shows a note in that place. In every fixture a unit's note is a direct child of
the card, after its blocks (`WARGEAR COSTS REMOVED` in `adeptus-custodes.html`, `BODYGUARD
UNITS UPDATED` in `space-marines.html`).

## Decision
A tier is read from each label `isUnitCard` counts, and from nothing else: a
`div.bg-slate-200` whose whole text reads `YOUR … COST(S)` (`TIER_LABEL_RE`) and whose next
sibling is the `ul.leaders` of its rows. One function, `tierLabels` in
`src/parse/page.ts`, finds them for both.

Anything else is left over for the coverage check:
- a note before a label is reported alone: `unit "CANOPTEK WRAITHS": "POINTS REVISED"`;
- a note between a label and its list separates them, so the whole tier is reported:
  `"YOUR 2ND + UNIT COSTSPOINTS REVISED3 models115 pts6 models240 pts"`;
- a card whose only tier is separated that way has no tier label, so it reads as a
  detachment and fails as one, the cost 0036 already accepted for the anchored label.

## Consequences
- Every fixture parses to the same data as before, and the live site's 30 pages, scraped
  on 2026-10-26, matched `data/` byte for byte.
- This is a fail-loud change, not handling for a variant nobody has seen, so it needs no
  fixture of its own: it reads nothing new, and refuses what it used to misread.
- If GW starts putting notes inside a tier's wrapper, every card with one fails until the
  note is added to `CHANGE_BADGE_TEXT`, which is how any new note is accepted.

Rejected:
- **Waiting for a fixture that shows the shape.** The misread produces no error, so nothing
  would prompt anyone to save that fixture. The shape would first be seen as a wrong tier
  in `data/`.
