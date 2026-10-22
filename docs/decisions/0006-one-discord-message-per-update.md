# 0006. One Discord message per update, remembered on its PR

- **Status:** accepted, [#39](https://github.com/BSData/wh40k-11e-mfm/pull/39); the permalink in [#43](https://github.com/BSData/wh40k-11e-mfm/pull/43); posting anew only on a 404 in [#86](https://github.com/BSData/wh40k-11e-mfm/pull/86)
- **Spec:** [change tracking — One message per update](../../specs/change-tracking.md#one-message-per-update-edited-as-the-update-grows)

## Context
The announcement fires when the scrape **detects** the change, not when the PR is merged,
so the channel hears about an update the day it lands rather than whenever a human gets
round to the review. That puts it on the wrong side of the sticky PR: an update's branch is
force-pushed daily, so "an update" is a branch that accretes over days, not an event. A
message per run would announce the same update every day.

## Decision
The PR is the message's identity. The message id is kept in a hidden marker in a comment
on the update PR (`<!-- discord-message-id: … -->`), written with the workflow's own
`GITHUB_TOKEN`, and that marker is the entire state: no marker means post and record the
id; a marker means edit that message.

The PR is the natural carrier because it lives exactly as long as the update does: once
merged and its branch deleted, the next update opens a fresh PR with no marker and gets a
fresh message. A new version stacks a new PR, so it gets its own message. Rejected: a PAT,
a cache, and state committed to `data/`, which has to stay byte-reproducible
([0002](0002-name-and-date-an-update-from-the-data.md)).

Deciding from the marker rather than from `create-pull-request`'s `created`/`updated`
output is what makes a failed post **self-healing**: a post that never landed leaves no
marker, so the next run posts rather than assuming yesterday succeeded.

## Consequences
- A multi-day update is one message whose numbers widen as its window does, like the PR
  title and the changelog entry. Day one's thin summary doesn't stay wrong.
- Each run PATCHes the message while the PR is open, even when nothing changed: one
  request a day, against an update going unannounced because one call failed once.
- An edit answered 404 (the message was deleted, or the id is stale) posts a new message.
  Any other failed edit (a 429, a 5xx) throws instead: the message is still there, and
  posting anew would announce the update twice.
- The marker comment also carries the message's permalink, so a reviewer can open the
  announcement. Building it needs the guild, which only the webhook object has, so the
  sender fetches it once per post; a failure there costs the link, not the announcement.
- Deleting the comment forces a repost: the manual escape hatch.
