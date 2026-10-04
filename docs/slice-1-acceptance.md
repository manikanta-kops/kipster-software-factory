# Slice 1 acceptance — 2026-10-04

Slice 1 reached its acceptance boundary: a ticket created and operated through
the web app became [factory-floor PR #1](https://github.com/manikanta-kops/kipster-factory-floor/pull/1),
against `next`, at commit `e8a506b50c5bddc97f0e447371466b009a8ff79a`.
It remains open for the owner. Neither repository was merged.

## Environment and owner flow

The factory started from `origin/next` at `4dadd22` in the separate
`kipster-slice-one-acceptance` worktree. `npm run dev` used Node 26.10.0,
PostgreSQL, a fresh `.local/` database and `.local/factory` home. Every agent
step used the real default executor, Codex CLI 0.160.0, in a fresh session.
No scripted executor, seeded ticket or direct database/API mutation drove the
live flow. The private test bed was registered through Repositories; its
actual default branch is `next`, at base `1e74b10`.

Ticket #1 requested **Stuck kips** beside **Blocked orders**, using the same
styling, with a unit test and an updated browser test. Through the web app,
the owner read the plan, requested a regression proving two blocked orders at
one station count as one stuck kip and clear live after restocking, and
approved the revised plan. All decisions, retries and cancellation used the
web app. The PR body and five-file diff were inspected, including in GitHub.

## Ticket #1 timeline

Times come from persisted attempts. Rounds count finished outcomes;
failed/interrupted attempts and human asks do not consume agent rounds.

| Attempt | Step / round      | Outcome        | Start (UTC) | Duration          |
| ------- | ----------------- | -------------- | ----------- | ----------------- |
| 1       | plan              | failed         | 13:19:49    | 1s                |
| 2       | plan (human ask)  | retry          | 13:19:50    | 39s               |
| 3       | plan              | interrupted    | 13:20:30    | 12s               |
| 4       | plan / 1          | done           | 13:20:41    | 79s               |
| 6       | approve-plan / 1  | changes-needed | 13:22:00    | 25s               |
| 7       | plan / 2          | done           | 13:22:25    | 81s               |
| 10      | approve-plan / 2  | approved       | 13:23:46    | 50s               |
| 12      | build             | interrupted    | 13:24:36    | 85s               |
| 13      | build             | interrupted    | 13:26:01    | 0.1s              |
| 14      | build (human ask) | retry          | 13:26:01    | 104s              |
| 15      | build             | failed         | 13:27:45    | 136s              |
| 16      | build (human ask) | retry          | 13:30:01    | 157s              |
| 17      | build / 1         | done           | 13:32:38    | 113s              |
| 18      | review / 1        | passed         | 13:34:32    | 63s               |
| 19      | maintain-pr / 1   | ready          | 13:35:34    | 4s                |
| 20      | merge             | waiting        | 13:35:39    | waiting for owner |

The deliberate SIGKILL stopped the active planner's process group; restart
marked the attempt interrupted and retried automatically. Later factory source
edits and formatting triggered two rapid development reloads during build,
correctly opening a human ask. The UI retry preserved the worktree. A successful
builder then exposed an exit-cleanup error; after its fix, a fresh builder
rechecked the same commit and the independent reviewer passed it.

The live reviewer found no blocking issue, so no review-to-build loop was
needed. Automated integration tests separately exercise two build/review
rounds, plan revision and current-only PR content.

## Decision and cancellation — ticket #2

A separate real planner investigated amber versus red warning styling,
installed dependencies and built the baseline before reporting
`needs-decision`. Needs you displayed the question. The owner selected amber
for the new summary card and retried; the fresh planner recorded that choice
and finished its revised plan. Rejecting the plan cancelled this exercise
before implementation or publication.

| Attempt | Step / round     | Outcome        | Start (UTC) | Duration |
| ------- | ---------------- | -------------- | ----------- | -------- |
| 5       | plan / 1         | needs-decision | 13:21:19    | 80s      |
| 8       | plan (human ask) | retry          | 13:22:39    | 9s       |
| 9       | plan / 2         | done           | 13:22:48    | 75s      |
| 11      | approve-plan / 1 | rejected       | 13:24:03    | 48s      |

The cancelled worktree contained real ignored `node_modules/` and `dist/`
output and occupied 130,700 KiB (127.6 MiB). Cleanup removed its repository
and ownership file; the parent then occupied 0 KiB. Repository refs were
byte-for-byte unchanged across cleanup. The cache, ticket #1 worktree and
ownership records, ticket #2 branch and copied step evidence remained.
Persistent cleanup state excludes ticket #2 from future scans. Tests also
preserve unknown ignored files, credentials, local data, untracked notes,
locks and symlinks.

## Fixes and why

- **Ignored output blocked cleanup.** Remove only allowlisted ignored
  dependency/build directories and record successful or already-completed
  cleanup. Preserve unknown state, dirty/locked worktrees, changed branches,
  symlinked roots and symlinked output directories.
- **Demo tickets could reach real agents.** Add `--no-scheduler` to `serve`
  and `dev`. Seeding holds the scheduler lock, requires an empty database and
  marks it as demo before insertion. The scheduler refuses marked databases
  before recovery or cloning. Migration 003 recognizes legacy demo-shop data;
  shipped migrations are unchanged.
- **Dev checkouts shared workspace IDs.** Keep each checkout's factory home
  under `.local/factory` with its existing local database; allow `--home`.
- **Registration assumed `main`.** Discover the clone's `origin/HEAD`, persist
  that default branch and repair legacy registrations on retry. The first live
  attempt failed on `origin/main`; its UI retry used `origin/next`.
- **Successful CLI exit became a failed step.** The first completed builder
  hit `kill EPERM` in the supervisor after Codex exited. Treat that as stopped
  only if the OS process table has no live group members; permission failures
  for live groups still fail. Regression tests cover both cases and a fresh
  real builder subsequently completed normally.
- **Publication mixed current work with history.** Publish the approved plan,
  latest finished step summaries, successful text/Markdown evidence and writer
  notes. Keep superseded plans, obsolete review rounds and operational notes
  in the timeline. Tests cover revision/review loops and file-backed evidence.
- **Prompts lacked dependency/evidence precision.** Planning ran baseline
  tools from the parent checkout without installing the test bed's dependencies.
  Planner/builder prompts now require the target repository's locked install.
  Plans should be proportional; revisions must replace the whole plan.
  Builders must record exact commands, counts and executed versus unverified
  scenarios, with generated evidence outside tracked source.
- **Concurrent browser suites collided.** Add `KSF_E2E_PORT`; this run used
  14867 while the other checkout's ports remained untouched.

No factory `web/` files changed. No screenshots were committed. Screenshot
uploads were omitted at the owner's request.

## Verification and retained evidence

Factory: `npm run check`, **160 unit/integration tests** and **22 Chromium
browser tests** passed. Database tests use real PostgreSQL. Process-permission
branches are injected; database behavior is not mocked.

Factory-floor: the completed builder and independent reviewer each ran
`npm run check`, **44 unit/integration tests** and **5 Chromium e2e tests**
successfully on `e8a506b`. The builder also ran 12 presentation cases
(zero/positive counts × 1280/768/390px × light/dark). The reviewer sampled
that presentation evidence rather than claiming to rerun it. The production
change is a pure count helper, a summary card and one grid-column adjustment;
the remaining diff is unit/e2e coverage. The body includes the revised approved
plan and successful evidence, without the original plan or recovery notes.
GitHub CI also passed for factory-floor PR #1 (check, tests and e2e) and the
factory's final code commit `8d76e6b` (check and tests).

Attempts, comments, results, prompts, logs and copied artifacts remain in the
local factory database and `.local/factory/steps/`. Ticket #1's completed
builder is attempt 17 and reviewer is attempt 18; the failed builder's original
commit/evidence remains at attempt 15. Read-only machine-readable exports were
retained at `/tmp/kipster-slice1-evidence/` during the run. The factory PR
description contains the timeline and evidence summary.

## Still unverified

- Real GitHub merge detection and post-merge cleanup: deliberately stopped
  before owner merge. Local integration tests cover merged/closed states.
- A live reviewer returning `changes-needed`: no serious finding warranted it;
  automated integration tests cover that loop.
- Claude execution, Firefox, WebKit and physical mobile devices were not run.
- Slice 2's isolated tester/kit lifecycle and enforced commit-bound verdicts,
  and Slice 3's base/CI/comment feedback loop, remain future work.

## Frictions for Slices 2 and 3

For Slice 2, make evidence a first-class record tied to a commit, with rendered
logs/media, isolated databases/ports and explicit dependency setup. Today's
proof depends on agent discipline and local paths. Inherited unrelated MCP
integrations produced startup authentication noise. The timeline is noisy with
raw events, running elapsed labels refresh only when data changes, and cleanup
success is not visible on the ticket page.

For Slice 3, use a writer to produce a short reviewer-facing description linking
to proof. The corrected body is accurate but still about 18.7k characters
because it embeds the full approved plan and evidence. Add CI/base tracking,
verdict invalidation after changes and PR-comment routing. Development file
watching also interrupts active work when fixing the factory itself; keep
execution stable during acceptance runs.
