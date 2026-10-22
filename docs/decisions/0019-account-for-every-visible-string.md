# 0019. Account for every visible string on the page

- **Status:** accepted, [#8](https://github.com/BSData/wh40k-11e-mfm/pull/8); coverage as consumed strings in [#85](https://github.com/BSData/wh40k-11e-mfm/pull/85)
- **Spec:** [scraping — Completeness coverage](../../specs/scraping.md#completeness-coverage-dont-silently-drop-new-content)

## Context
The parser is a *pull* parser: it reads specific selectors and ignores everything else. A
new section, field, badge or row that GW adds would vanish with no error and no diff,
which for a dataset is the worst failure, because nobody notices. When the check was
introduced it found three things the parser had been dropping all along: a sub-faction's
`parent`, a detachment's `UNIQUE:` restriction and an enhancement's `LEADER:` grant.

The first version counted a card as covered by matching its selectors a second time, so a
string the parser looked at but didn't keep still counted as covered. That is how, on the
live v1.6 site, two change notes nobody had listed (`BODYGUARD UNITS UPDATED`, `WARGEAR
COSTS REMOVED`) and non-numeric enhancement points went unreported.

## Decision
Every visible string on a faction page must be accounted for, or the faction fails. A
string is covered only if a parse step **consumed** it, recording the exact text it turned
into data, or if it is on an allowlist. Anything left over fails the parse, naming the card
and the text.

The allowlists live on their own (`src/allowlists.ts`, guarded by code owners) as the
deliberate-change surface. New chrome is added there, string by string, in a reviewed
commit; new data is taught to the parser. Either way the change goes through review rather
than being lost.

## Consequences
A site change fails loudly, and the scrape stops updating that faction until someone
looks ([0020](0020-fail-loud-and-located.md)). An allowlist entry that is too broad is how
a real addition gets swallowed, so they stay tight.
