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

## Slice 2: Proof (done)

Read the repository kit. The tester drives an isolated instance and stores
evidence (screenshots, recordings, logs) shown on the ticket. Verdicts are tied
to a commit. The `onboard-repo` workflow writes and proves the test bed's kit.
The onboarder formats all generated files, including hidden kit files, and
runs the repository's checks before reporting completion.

Proven with real agents on factory-floor: kit setup, checks and readiness;
station completion counts with screenshots, recordings, traces and timed
observations; and an Orders navigation bug reproduced on base and independently
proved failing on base and passing on the fix. Evidence remains on the ticket,
with live agent logs and seekable recordings. A commit change invalidates the
verdict. Live application/database-process restart was not exercised; the
approved persistence check recreated the engine and connection against real
PostgreSQL. These are distinct claims in the evidence and PR description.

## Slice 3: Ready to merge (done)

`maintain-pr` fetches and merges the default branch without rewriting history,
aborts conflicts with file findings, and reports `base-moved` when the latest
tester verdict no longer
covers the resulting commit. A fresh writer session creates a short description
per head with evidence links, `Verified at <sha>`, an optional Mermaid diagram,
and a Merge danger line explaining reversibility and blast radius.

After pushing, CI is checked at the exact head. Pending checks park persistently
without a scheduler slot. Required checks must pass; failures return log excerpts
to the builder, no checks continue immediately, and `with.ciTimeoutMinutes`
(default 60) bounds waiting with an owner decision. Slice 4 replaces installation-specific evidence links with factory ticket references. While merge waits, current change requests and new
owner comments become deduplicated comment artifacts and `changes-needed`.
Base advancement during either CI or owner-merge waiting queues another
scheduled maintenance attempt and refreshes proof before republishing. The
owner still performs every merge.

Proven live on factory-floor with required GitHub CI and real writer sessions:
an unrelated README merge advanced protected `next`, triggering synchronization
and fresh proof; a PR review comment reached the builder and produced a tested
keyboard regression; a later bug merge advanced the base while feature CI was
waiting, exposing and validating recovery from an obsolete merge wait. The
factory detected owner merges and refreshed the repository's verify capability
after the kit landed. CI waits also survived a deliberate safe server restart.
The [acceptance report](https://github.com/manikanta-kops/kipster-software-factory/pull/10)
records ticket timelines, evidence, fixes and limitations. Failure/log retrieval,
timeouts, conflicts and PR closure have automated coverage using real PostgreSQL
and Git remotes with controlled GitHub/writer boundaries; an artificial floor CI
failure was not injected during acceptance.

## Slice 4: Decisions and merging

Wave 1 adds facts and rules; the owner still merges. The merge gate checks
current independent proof and reproduction comparisons, base ancestry, required
CI, open feedback, build work and PR state. Kit, CI and migration paths always
need the owner; extra migration globs come only from the trusted default kit.
The ticket shows live checks and retains an older green head while rebuilding.
Scenario evidence has durable per-ticket storage, stable in-app routes, a curated
index, an expandable archive and configurable retention (default 30 days after
completion, retaining final-commit index items). No integration is required to
store or view local evidence. Structured owner-approved unverified scenario data
is not provided by the gate/evidence slice and is explicitly unavailable.

Typed decisions, confidence bands and their override log are a parallel Wave 1
slice. Wave 2 adds opt-in per-repository auto-merge in PostgreSQL, based on hard
rules and passing independent tester/reviewer verdicts at the exact PR head.
A typed reviewer owner-review flag and missing reviewers retain owner merging;
there is no model on the merge path. Fresh gate re-evaluation and head-matched
squash merging protect each call. Durable requests reconcile lost responses and
crashes. Bug workflows include a reviewer. Background post-merge checks watch
the exact merge commit (or run the kit check without CI), and atomically open
one bug ticket and linked timeline note on failure. Kit infrastructure retries
are bounded before reporting unavailable. Consecutive base-moved re-syncs are
bounded by `maxBaseSyncs` (default 3), reset by builder/tester work, owner retry
or merge; initial publication and feedback rebuilds do not count. A CI settle
window (default 3 minutes) protects against late registration after pushes;
untested workflows show a needs-owner reason without being blocked. Evidence is
copied before the ticket transaction and rolled-back copies are cleaned up.

Hosted attachments come later: an optional configured storage target and a
`publish-evidence` system action will upload retained items and record hosted
URLs for the writer. Without that integration, PRs say “Evidence on ticket #<n>
in the factory” and contain no local links. Configuration must be optional; the
factory's local evidence workflow continues to work without storage hosting.

## Slice 5: Larger work

Optional hosted evidence uploads through `publish-evidence` with a configured
storage target; local evidence remains the default.

Builders can request a linked ticket in another registered repository with
`needs-other-repo`. The original waits without an executor slot, then its builder
runs in a fresh attempt with its original explanation, full request, linked PR URL
and merge commit. The linked ticket
runs its own workflow and approval. Cancellation of the linked ticket asks the
original owner; cancelling the original leaves the linked ticket independent.

Tickets can select registered read-only dependency repositories. Every agent
session receives freshly fetched default-branch checkouts with paths and exact
commits. File permissions block ordinary writes; post-session checks detect
content, ignored-file, permission and Git metadata changes, fail to the owner and
restore the checkouts. Linked tickets automatically read the original repository.
Checkouts share cached objects, pin their commits through force-pushes and cache
GC, and are removed with their pins after done/cancel even if the ticket worktree
must be retained. Snapshots exclude Git packs; restoration uses the step signal.

A `lead` role splits a ticket into tasks; `run-tasks` runs them as child
tickets, up to a parallel limit, and wakes the lead each time one finishes,
fails, conflicts or has a pull request ready. Branch tasks merge into the
lead's branch; pull request tasks merge when the lead chooses and the merge
policy allows. A lead may give a task an allowed agent, model and effort. A live
smoke with real Claude sessions on a throwaway repository ran a lead, three
branch tasks two at a time, a report after each and a final `done`. Pull
request tasks, testers inside tasks and Codex leads have not run live, nor on
factory-floor.

## Slice 6: The factory builds itself

Factory work runs through the factory, then Kipster's does.
