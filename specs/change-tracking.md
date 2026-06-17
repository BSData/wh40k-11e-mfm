# Spec: Change tracking

Goal: surface what changed whenever Games Workshop updates the MFM, with a clean
audit trail. Implemented by [`src/diff.ts`](../src/diff.ts) plus git itself.

## How it works
1. The committed `data/*.yaml` is the **previous** snapshot.
2. The scrape overwrites `data/` with the **current** snapshot.
3. `git diff data/` is the canonical, line-level change history (deterministic YAML
   ordering keeps each change to a minimal diff).
4. `src/diff.ts` renders a **human-readable changelog** by comparing the two snapshots
   (old copy vs. freshly scraped), grouped by faction:
   - version change
   - units / detachments added or removed
   - per-option points changes with a signed delta, e.g.
     `Necron Warriors — 10 models: 80 → 90 pts (+10)`
   - enhancement points changes

This is pure code — no LLM. An optional LLM polish step could summarise the changelog
into prose later, but is not required.

## Workflow integration
The scrape GitHub Action:
1. snapshots the committed `data/` to a temp dir,
2. runs the scrape,
3. runs `tsx src/diff.ts <old> data` to produce the changelog,
4. if `data/` changed, opens a PR whose body is the changelog,
5. if the scrape fails to parse, opens an issue instead.

A human reviews and merges the PR — giving reviewable, auditable history of every
points change.
