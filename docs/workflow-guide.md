# Workflow guide

Principles for workflows that produce work you can trust. Each one comes from a
failure seen in practice.

## Proof

- **Prove, don't claim.** What counts is evidence: a run, a screenshot, a
  recording. An agent's summary is not evidence.
- **The author never judges its own work.** Testing and review are separate
  sessions that did not write the change.
- **Test the real thing.** Drive the running app the way a user would. Unit
  tests show code paths, not that a bug is gone.
- **Reproduce before fixing.** A bug fix starts by showing the failure on the
  base branch, then the same check passing on the branch.
- **A verdict belongs to one commit.** Any new commit, including an update from
  the base branch, voids it.
- **Nothing edits what judges it.** Changes to the kit, CI or protected tests
  always go to a human.

## Agreement

- **Agree the outcome, not the implementation.** A plan carries acceptance
  scenarios the tester can run. For UI, a clickable prototype beats prose.
- **Questions that running something can answer are the agent's.** Only product
  and taste questions reach a human.
- **Thin vertical slices.** Each ticket should fit in one fresh
  session and work end to end.

## Flow

- **One fresh session per step.** Pass artifacts and the branch, never a
  conversation.
- **Route on typed outcomes,** never on free text.
- **Every loop has a limit.** Running out means "needs you" with everything
  attached, or an explicit route such as opening the PR with notes.
- **Bound review.** Leads use up to five rounds, with parallel reviewers from
  configured CLI families. Later rounds check earlier corrections and serious
  problems added by fixes. Other workflows retain their explicit review limits;
  block only on serious findings and let the author decline the rest in writing.
- **Agents propose, the system acts.** Only system steps push, open pull
  requests or merge.

## Decisions and merging

- **Hard rules first.** Paths that always need a human (migrations, the kit, CI)
  are rules, not judgements.
- **Decisions only choose within the rules,** and below the confidence band
  they go to a human.
- **Decide on facts, not prose.** Build a decision's input from file paths,
  diff statistics and test results, never from an agent's description of its
  own change.

Repository auto-merge is off by default. Turn it on in Repositories to let the
system merge when the live gate is ready with no owner reasons and the latest
independent tester and reviewer both passed at the exact PR head. Every merge
re-checks fresh facts and uses a head-matched squash merge. No model judges
merge safety; TypeSafe remains optional for workflow `decide` steps.

Migrations, kit and CI changes, untested or unreviewed workflows, and invalid
trusted kits retain owner merging. The reviewer can also pass with a typed
`ownerReview: { reason: "…" }` for correct changes involving auth/permissions,
data deletion or rewrites, public contracts, security-sensitive code or weakened
tests. Publication proceeds normally, and the gate shows the reviewer's reason
for your review. The flag is validated; prose cannot set it. Bug fixes include a
review after testing, with two review rounds before asking you.

`maintain-pr.with.ciSettleMinutes` defaults to 3: absent checks wait briefly after
a push so late CI can register and use the `ci-failed` route.
Base synchronization invalidates prior tester and reviewer verdicts. Route
`base-moved` to testing, or to review for a workflow without a tester.
`maintain-pr.with.maxBaseSyncs` defaults to 3: repeated base advances then park
for you with a summary. Only re-syncs from a base-moved PR wait count. Builder
or tester work breaks the streak; initial publication and feedback rebuilds do
not count. Merge, retry or move resets it as well.

After any PR merge, background checks watch the merge commit on the default
branch. Repositories with no CI use the kit check in a disposable checkout.
Failures create one bug ticket per merge commit and link it from the original
timeline; other tickets continue running. Kit infrastructure failures retry
three times, then report an unavailable check with the reason.

## Work through a lead

- **The lead decides, tasks do.** A lead never writes code. Each task is a
  child ticket with its own build and check loop, so one failure does not
  stop the rest.
- **Hear every finish.** The lead wakes on each finished, failed or
  conflicting task and on each ready pull request, not only when all are done.
- **Write tasks for a stranger.** Task agents see only the task's title and
  instructions. Name the goal, the files, the checks and what is out of scope.
- **Author and reviewer differ.** A task's agent runs only its builder; the
  reviewer keeps its own setting. Set per-workflow agents and timeouts on the
  Settings page, not in the workflow file.
- **Parallel only when separate.** Tasks given out together should touch
  different files. Delegate dependent work after its prerequisite merges.
- **Bound the loop.** Give `run-tasks` a limit: each report is a lead session.

## Learning

- **Lessons become checks.** A repeated mistake becomes a test, lint or script,
  not another paragraph of instructions.
- **Measure by interruptions.** A good workflow is one where you rarely step in
  after a ticket says it is ready.

## Showing work to people

- **Show only what needs a person.** Done work collapses out of the way.
- **Draw a workflow as a list with loops.** Back-edges are labelled loops;
  everything else follows the order.

## Work across repositories

- **Read dependencies, change the target.** Select registered dependencies as
  read-only reference material. Each agent session receives their current default
  branch paths and commits; dependency edits fail to the owner and are restored.
- **Request the needed change.** A builder uses `needs-other-repo` with a target,
  title and body explaining the change and why it is needed. The system opens a
  linked ticket with its own workflow (default `lead`) and plan approval.
- **Resume on confirmed merge.** The original parks without an executor slot and
  starts a fresh builder attempt after the linked ticket finishes with a confirmed
  merged PR. That attempt receives the original builder explanation, full request,
  PR URL and merge commit. Linked tickets are polled at the merge-poll interval.
  A cancelled link
  or an invalid request asks the owner.
- **Keep cancellation local.** Cancelling the original does not cancel linked
  work. The ticket page states this before cancellation.
