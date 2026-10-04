# Roadmap

The factory grows in slices. Each slice works end to end and is proven on the
kipster-factory-floor test bed, a private repository, before the next starts.

## Slice 0: Foundation (done)

The vocabulary and the skeleton run: catalog of roles, actions and capabilities;
workflow validation and routing; built-in workflows; PostgreSQL store and
migrations; API; web app that shows what needs you and draws workflows; CLI; CI.

## Slice 1: A ticket becomes a pull request (done)

Register a repository (cloned once, a worktree per ticket). Create a ticket in
the web app. The scheduler runs agent steps through the Claude Code and Codex
CLIs, each ending with a `result.json` outcome. Human steps appear in Needs you
with approve, change and reject. A system step opens the pull request. The
ticket page shows the plan, comments and every attempt.

Proven on 2026-10-04 with the real default Codex executor, web-only ticket
operations, a requested plan revision, independent review and
[factory-floor PR #1](https://github.com/manikanta-kops/kipster-factory-floor/pull/1).
Crash/retry, a real decision and cancellation cleanup were exercised. The PR
is left for the owner to merge. See the [acceptance record](slice-1-acceptance.md)
for the timeline, fixes, tests and remaining limits.

## Slice 2: Proof

Read the repository kit. The tester drives an isolated instance and stores
evidence (screenshots, recordings, logs) shown on the ticket. Verdicts are tied
to a commit. The `onboard-repo` workflow writes and proves the test bed's kit.
The Slice 1 run reinforces explicit dependency setup, isolated ports/databases,
readable evidence linked to a commit and clearer runtime/cleanup status.

## Slice 3: Ready to merge

`maintain-pr` keeps the pull request current: updates from base, waits for CI,
and sends the ticket back when either changes something. The writer keeps the
description clear, with a diagram. Pull request comments become
`changes-needed`. The Slice 1 run also showed the need for a concise PR
narrative linking to evidence instead of embedding the full plan and logs.

## Slice 4: Decisions and merging

Typed decisions with confidence bands, logged so overrides can tune thresholds.
Merge policy with path rules and decisions; automatic merges for what the policy
allows; a post-merge check that opens a bug ticket when something breaks.

## Slice 5: Larger work

`split` and `wait-children` run phases as child tickets. `needs-other-repo`
opens a linked ticket in another repository. Read-only dependency repositories.

## Slice 6: The factory builds itself

Factory work runs through the factory, then Kipster's does.
