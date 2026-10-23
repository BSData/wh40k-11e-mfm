# 0007. Announce how much of each faction moved

- **Status:** accepted, [#39](https://github.com/BSData/wh40k-11e-mfm/pull/39)
- **Spec:** [change tracking — What the message says](../../specs/change-tracking.md#what-the-message-says)

## Context
A Discord embed has room for a summary and a list, not the changelog, so the list has to
be ranked by something. Two rankings were tried and rejected:
- By individual point delta. The biggest single swings in a real update are a dozen
  near-identical variants of one vehicle: v1.3's largest fourteen were almost all Leman
  Russ turrets.
- By a faction's **net** points. Worse than it looks: an update reprices unrelated units,
  so the deltas cancel (a faction with eight changes can net zero), and the total is not a
  quantity anyone plays with.

## Decision
The message lists every faction that moved with the number of units and detachments that
moved in it, busiest first, and names the factions a global revision swept up without
touching separately. "How much of my faction moved" is the question a reader has, and a
count answers it. The colour is fixed: Discord reads embed colour as status, and the net
direction of an update is not good or bad news.

The changelog link points at the **PR**, not at the version's changelog file on `main`:
when the announcement fires, `main` doesn't have the file yet, and a link there is worse
than none. The PR body is this update's changelog, and stays correct after the merge.

## Consequences
The message carries no net total and no individual deltas; those are one click away, in
the PR.
