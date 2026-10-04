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

Proven with the real default Codex executor on the factory-floor test bed:
web-only ticket operations, a requested plan revision, independent review and
an opened pull request, plus crash recovery, a real decision and cancellation
cleanup.

## Slice 2: Proof

Read the repository kit. The tester drives an isolated instance and stores
evidence (screenshots, recordings, logs) shown on the ticket. Verdicts are tied
to a commit. The `onboard-repo` workflow writes and proves the test bed's kit.
The Slice 1 run reinforces explicit dependency setup, isolated ports/databases,
readable evidence linked to a commit and clearer runtime/cleanup status.

## Slice 3: Ready to merge

The system-action path is implemented and covered locally. `maintain-pr` fetches
and merges the default branch without rewriting history, aborts conflicts with
file findings, and reports `base-moved` when the latest tester verdict no longer
covers the resulting commit. A fresh writer session creates a short description
per head with evidence links, `Verified at <sha>`, an optional Mermaid diagram,
and a Merge danger line explaining reversibility and blast radius.

After pushing, CI is checked at the exact head. Pending checks park persistently
without a scheduler slot. Required checks must pass; failures return log excerpts
to the builder, no checks continue immediately, and `with.ciTimeoutMinutes`
(default 60) bounds waiting with an owner decision. `with.factoryUrl` sets the
public evidence-link origin. While merge waits, current change requests and new
owner comments become deduplicated comment artifacts and `changes-needed`.
The owner still performs every merge.

Local coverage uses PostgreSQL, bare Git remotes, stubbed GitHub and the fake
writer. This slice is not yet proven end to end on the factory-floor: a live
GitHub run must exercise base movement/retest, CI pending/failure/log retrieval,
owner feedback/rebuild, and merge/close. The independent tester execution and
web presentation work are separate changes; this PR adds the additive
`pull-request-checks` waiting value for the web to display.

## Slice 4: Decisions and merging

Typed decisions with confidence bands, logged so overrides can tune thresholds.
Merge policy with path rules and decisions; automatic merges for what the policy
allows; a post-merge check that opens a bug ticket when something breaks.

## Slice 5: Larger work

`split` and `wait-children` run phases as child tickets. `needs-other-repo`
opens a linked ticket in another repository. Read-only dependency repositories.

## Slice 6: The factory builds itself

Factory work runs through the factory, then Kipster's does.
