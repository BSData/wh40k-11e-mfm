Closes #

## What and why


## Checklist
See [CONTRIBUTING.md](https://github.com/BSData/wh40k-11e-mfm/blob/main/CONTRIBUTING.md).

- [ ] The spec in `specs/` was updated first, or nothing it describes changes.
- [ ] `pnpm verify` passes.
- [ ] Parser changes come with fixture evidence: a saved page in `test/fixtures/` shows the
      markup, and a test fails without the change. (Or there is no parser change.)
- [ ] `data/`, `changelog/` and `DATA-CHANGELOG.md` aren't hand-edited. Any regenerated
      output comes from the scraper and is called out above.
