# wh40k-mfm-scraper

Scrapes the official Warhammer 40,000 **Munitorum Field Manual**
(<https://mfm.warhammer-community.com/en>) into clean, versioned YAML and tracks points
changes over time.

- **Dataset** — one human-readable file per faction in [`data/`](data/).
- **Change history** — deterministic YAML means `git log -p data/` is a precise record of
  every points change, and [`DATA-CHANGELOG.md`](DATA-CHANGELOG.md) indexes a readable
  changelog per MFM version.

## Using the data

### What's where
| Path | Contents |
|---|---|
| `data/<slug>.yaml` | One faction: its units' points (per unit size and requisition tier), wargear costs and Leader/Support lists, and its detachments with their DP and enhancements. |
| `data/meta.yaml` | The `schemaVersion`, the MFM version, the date of the last change, the `factions` list of slugs, and the site's rules panels ("Welcome…" notes and "Muster Armies") as Markdown. |
| [`data/points.csv`](data/points.csv) | Every unit's points as one table for spreadsheets: one row per faction, unit, tier and cost option. UTF-8; in Excel, open it with Data → From Text/CSV. |
| [`schema/`](schema) | JSON Schemas for a faction file, `meta.yaml` and `all.json`, generated from the model. |
| `changelog/v<version>.md` | What changed in each MFM version, indexed by [`DATA-CHANGELOG.md`](DATA-CHANGELOG.md). |

Every field is documented in [`specs/data-model.md`](specs/data-model.md). A slug is the
faction's URL slug on the MFM site: `data/necrons.yaml` is
<https://mfm.warhammer-community.com/en/necrons>.

### Releases
Every change to the data on `main` is published as a
[release](https://github.com/BSData/wh40k-11e-mfm/releases), tagged
`mfm-v<version>+<date>` after the last day of the change (`mfm-v1.5+2026-10-05`; a second
change ending the same day adds `.2`), with that change's changelog entry as its notes. A
release never changes once published. Each one has the same assets, so the newest is
always at the same URL:

```text
https://github.com/BSData/wh40k-11e-mfm/releases/latest/download/all.json
https://github.com/BSData/wh40k-11e-mfm/releases/latest/download/points.csv
```

| Asset | Contents |
|---|---|
| `all.json` | `meta.yaml` and every faction in one file: `{ "schemaVersion": 2, "meta": …, "factions": […] }` |
| `points.csv` | `data/points.csv` |
| `faction.schema.json`, `meta.schema.json`, `all.schema.json` | the JSON Schemas |
| `data.zip` | all of `data/` |

To pin a release, download from its tag instead of `latest`:
`https://github.com/BSData/wh40k-11e-mfm/releases/download/mfm-v1.6+2026-10-23/all.json`.
The `+` works as it is in a URL; `%2B` works too. A version's tags sort by date as text,
except that a `.10` sorts before a `.2`.

### Schema version
`schemaVersion` (in `meta.yaml` and `all.json`) goes up by one whenever the files change in
a way that can break a reader: a field removed or renamed, or its type or meaning changed
(a required field becoming optional counts). Added fields don't change it. Check it before
reading the rest, and validate against the JSON Schema of the same release if you want the
shape checked; the schemas accept fields they don't list, so a later addition doesn't fail
them. A bump is announced in its release notes and on Discord. The policy is in
[`specs/data-model.md`](specs/data-model.md#schema-version-schemaversion).

### Stable URLs
Read the files from `raw.githubusercontent.com`. A file's path follows the faction's slug on
the MFM site, and no slug has changed so far:

```text
https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/main/data/meta.yaml
https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/main/data/necrons.yaml
```

`meta.yaml` lists every faction's slug, so you don't need the rate-limited GitHub API to
find the files. In JavaScript, with the [`yaml`](https://www.npmjs.com/package/yaml)
package:

```js
import { parse } from 'yaml';

const base = 'https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/main/data';
const get = async (file) => parse(await (await fetch(`${base}/${file}`)).text());

const meta = await get('meta.yaml');
const factions = await Promise.all(meta.factions.map((slug) => get(`${slug}.yaml`)));
```

To pin a snapshot that never changes, put a commit SHA in place of `main`.

`version` is a quoted string (`"1.6"`). `firstSeen` and `lastUpdated` are unquoted dates
(`2026-10-14`): some parsers, such as PyYAML and js-yaml, return them as dates, and others,
such as the `yaml` package, as strings.

### Updates, and why `main` lags the site
A scheduled job scrapes the MFM every day at 16:00 UTC. When anything has changed, it opens
or updates a pull request for that MFM version, labelled
[`mfm-update`](https://github.com/BSData/wh40k-11e-mfm/pulls?q=is%3Apr+is%3Aopen+label%3Amfm-update),
and the data reaches `main` only when a maintainer has reviewed and merged it. That can take
days: MFM v1.6 was first seen on 2026-10-14, and its update was merged on 2026-10-22. So:
- `main` holds reviewed data, which may be behind the site. `meta.yaml`'s `version` says
  which MFM version it is, and each faction's `firstSeen` says when its current values were
  first seen.
- The newest values are on the open update PR's branch, `mfm/v<version>`, at
  `https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/mfm/v<version>/data/<slug>.yaml`.
  They haven't been reviewed. The branch is rewritten whenever a run finds a change and
  deleted when the PR merges, so find it from the open PR rather than hard-coding it. If
  two are open, the newer version's PR is stacked on the older one.
- [`DATA-CHANGELOG.md`](DATA-CHANGELOG.md) links each version's changelog. The files have
  had one breaking change so far, noted in [`changelog/v1.4.md`](changelog/v1.4.md):
  `role` and `attachTo` became `leaderTo` and `supportTo`, and `objective` became
  `objectives`. That is why `schemaVersion` starts at 2. Every other change, such as
  `muster` in `meta.yaml`, only added fields.
- Releases follow `main`, so they lag the site the same way.

## License
The code is released under the [MIT License](LICENSE).

The dataset (`data/`, and the changelogs generated from it) reformats points values that
Games Workshop publishes in the Munitorum Field Manual, and `test/fixtures/` holds saved
copies of the manual's pages. That content is Games Workshop's, and this repository carries
no additional grant for it: the MIT License covers this project's own code, not Games
Workshop's content. If you use or republish the data, attribute it, for example "Points
from the Munitorum Field Manual (© Games Workshop), via BSData/wh40k-11e-mfm", and keep the
[disclaimer](#disclaimer) with it.

## Contributing
A value that doesn't match the MFM site?
[Report a points mismatch](https://github.com/BSData/wh40k-11e-mfm/issues/new?template=points-mismatch.yml);
no coding needed. For everything else, including code, see
[`CONTRIBUTING.md`](CONTRIBUTING.md). Problems in New Recruit or BattleScribe belong to
[BSData/wh40k-11e](https://github.com/BSData/wh40k-11e/issues).

## How it works
The MFM site is server-rendered, so the scrape is a plain HTTP GET per page and an HTML
parse, with no browser. Each faction page is requested with the cookie the site's "Show
Legends" toggle sets, so the **Legends** units come back with it, and the expandable
**"Welcome…" notes** and **"Muster Armies" rules** are read from the page's React Server
Components payload. `pnpm scrape --browser` cross-checks all of it against Google Chrome's
render, using the Chrome already installed.

- The scraped shape is validated against zod schemas (`src/model.ts`) before writing —
  drift fails loudly instead of producing bad data.
- The parser is covered by tests over real saved pages (`test/fixtures/`), so site changes
  are caught in CI.
- A daily GitHub Action re-scrapes, opens a PR on change, and files an issue if a parse
  breaks.
- Set a `DISCORD_WEBHOOK_URL` repository secret and each update is also announced to that
  channel — one message per update, edited as the update grows. No secret, no post.

TypeScript (Node 22, ESM) · cheerio · zod · `yaml` · Vitest · Biome · pnpm.

## For maintainers / agents
```bash
pnpm install
pnpm test                      # offline tests against saved HTML fixtures
pnpm scrape --faction necrons  # live run for one faction → data/necrons.yaml
pnpm scrape                    # full run, all factions (with Legends + notes)
pnpm scrape --browser          # the same, cross-checked against Google Chrome
```

See [`AGENTS.md`](AGENTS.md) for the project map and the commands,
[`.agents/skills/`](.agents/skills/) for the runbooks (notably what to do when a scrape
breaks), and [`specs/`](specs/) for the source-of-truth contracts.

## Disclaimer
Unofficial. Warhammer 40,000 and the Munitorum Field Manual are © Games Workshop. This
project reformats publicly available points values for personal/community reference and is
not affiliated with or endorsed by Games Workshop.
