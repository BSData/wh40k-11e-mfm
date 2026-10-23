# 0030. One short instruction file, for every harness

- **Status:** accepted, in [#101](https://github.com/BSData/wh40k-11e-mfm/pull/101)
- **Spec:** [`AGENTS.md`](../../AGENTS.md) itself, and the files that point to it

## Context
By October 2026 `AGENTS.md` had grown to 145 lines and 9.5 KB. A third of it was a
file-by-file project map that had to be rewritten with every restructure
([#90](https://github.com/BSData/wh40k-11e-mfm/pull/90) rewrote it), and much of the rest
repeated the README and the specs. Current guidance agrees on why that hurts:
- Claude Code's best practices keep only what the agent would otherwise get wrong:
  "Bloated CLAUDE.md files cause Claude to ignore your actual instructions", and they
  suggest staying under about 200 lines
  (<https://code.claude.com/docs/en/best-practices>, <https://code.claude.com/docs/en/memory>).
- A 2026 study found that context files don't generally raise task success, and add over
  20% to cost; they help mainly with non-standard practices
  (<https://arxiv.org/abs/2602.11988>).
- An always-loaded `AGENTS.md` docs index beat skills, which agents didn't invoke in 56% of
  cases (<https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals>). That
  measured a docs index, not a skills index; keeping a short skills index in `AGENTS.md` is
  this project's inference from it, and it is also the only way Claude Code finds the skills.
- Commands first, a way to verify the work, and clear boundaries are what the most useful
  files share
  (<https://github.blog/ai-and-ml/github-copilot/how-to-write-a-great-agents-md-lessons-from-over-2500-repositories/>).

The harnesses also read instruction files differently:
- Claude Code reads `AGENTS.md` itself only when there's no `CLAUDE.md` or
  `CLAUDE.local.md`, and doesn't scan `.agents/skills/`.
- Copilot, Cursor, OpenCode and Amp scan both `.claude/skills/` and `.agents/skills/`.
- Zed uses only the first instruction file it finds, and `.rules`, `.cursorrules` and
  `.github/copilot-instructions.md` all rank above `AGENTS.md`.

## Decision
- **`AGENTS.md` holds only what can't be worked out from the code.** That means the ground
  rules, the definition of done, the commands, the skills index, a few non-obvious
  conventions, and a directory-level map. Procedures live in skills; contracts in
  `specs/`; reasons here, in `docs/decisions/`. The ground rules and the definition of done
  come first.
- **`test/agents.test.ts` holds it to that.** The file stays under 5,000 characters, with
  the ground rules and the definition of done first. Every repository path it names
  exists, every `pnpm` script it runs is in `package.json`, and every skill is in its index.
- **One file for every harness, and nothing copied.**
  - `CLAUDE.md` holds only `@AGENTS.md`, so a contributor's `CLAUDE.local.md` doesn't hide it.
  - `.aider.conf.yml` loads it read-only.
  - There is no `.claude/skills/` copy and no symlink: a copy loads every skill twice in the
    harnesses that scan both folders, and symlinks break on Windows clones without
    `core.symlinks`.
  - There is no `.github/copilot-instructions.md`, `.cursorrules` or `.rules`: any of them
    would hide `AGENTS.md` from Zed.
- **One environment setup.** `scripts/setup` is called by `.devcontainer/devcontainer.json`,
  `.github/workflows/copilot-setup-steps.yml` (Copilot's coding agent) and `.agents/setup`
  (Amp).

## Consequences
- An agent explores `src/` instead of reading a map of it, and no list of thirty file names
  has to be kept in step with the code.
- A rule that only applies to one part of the tree belongs in a nested `AGENTS.md` there,
  with a sibling `CLAUDE.md` holding `@AGENTS.md`, since the root `CLAUDE.md` is what Claude
  Code reads instead of `AGENTS.md`.
- Copilot code review no longer stops reading at 4,000 characters; the cap was lifted in
  June 2026
  (<https://github.blog/changelog/2026-06-12-copilot-code-review-new-configurations-and-controls/>).
  The order still matters, so the most important rules come first.
