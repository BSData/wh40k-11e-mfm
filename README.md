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
| `data/meta.yaml` | The MFM version, the date of the last change, the `factions` list of slugs, and the site's rules panels ("Welcome…" notes and "Muster Armies") as Markdown. |
| `changelog/v<version>.md` | What changed in each MFM version, indexed by [`DATA-CHANGELOG.md`](DATA-CHANGELOG.md). |

Every field is documented in [`specs/data-model.md`](specs/data-model.md). A slug is the
faction's URL slug on the MFM site: `data/necrons.yaml` is
<https://mfm.warhammer-community.com/en/necrons>.

### Stable URLs
Read the files from `raw.githubusercontent.com`. Their paths don't change:

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
(`2026-10-14`): YAML 1.1 parsers, such as PyYAML, read them as dates, and YAML 1.2
parsers read them as strings.

### Updates, and why `main` lags the site
A scheduled job scrapes the MFM every day at 16:00 UTC. When anything has changed, it opens
or updates a pull request for that MFM version, labelled
[`mfm-update`](https://github.com/BSData/wh40k-11e-mfm/pulls?q=is%3Apr+is%3Aopen+label%3Amfm-update),
and the data reaches `main` only when a maintainer has reviewed and merged it. That can take
days: MFM v1.6 was first seen on 2026-10-14 and merged on 2026-10-22. So:
- `main` holds reviewed data, which may be behind the site. `meta.yaml`'s `version` says
  which MFM version it is, and each faction's `firstSeen` says when its current values were
  first seen.
- The newest values are on the open update PR's branch, `mfm/v<version>` (for example
  `https://raw.githubusercontent.com/BSData/wh40k-11e-mfm/mfm/v1.6/data/necrons.yaml`).
  They haven't been reviewed, and the branch is force-pushed on every run.
- [`DATA-CHANGELOG.md`](DATA-CHANGELOG.md) links each version's changelog. A change to the
  shape of the files is noted there too, as when v1.4 replaced `role` and `attachTo` with
  `leaderTo` and `supportTo`.

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
Most data is server-rendered, so the core scrape is a plain HTTP GET + HTML parse.
**Legends** units and the expandable **"Welcome…" notes** and **"Muster Armies" rules** are
client-only, so those are captured with a headless browser (Playwright); pass `--no-legends`
to skip it.

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
pnpm exec playwright install chromium   # once, for Legends/notes
pnpm test                      # offline tests against saved HTML fixtures
pnpm scrape --faction necrons  # live run for one faction → data/necrons.yaml
pnpm scrape --no-legends       # fast HTTP-only run (no browser)
pnpm scrape                    # full run, all factions (with Legends + notes)
```

See [`AGENTS.md`](AGENTS.md) for the project map, the commands and the runbooks (notably
what to do when a scrape breaks), and [`specs/`](specs/) for the source-of-truth contracts.

## Disclaimer
Unofficial. Warhammer 40,000 and the Munitorum Field Manual are © Games Workshop. This
project reformats publicly available points values for personal/community reference and is
not affiliated with or endorsed by Games Workshop.
