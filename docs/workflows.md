# Workflow format

New ticket offers the built-in `bug`, `lead` and `onboard-repo`, plus uploaded
workflows. `lead` covers features and small changes, with at most 20 tasks and
50 task reports. `task` and `task-pr` remain available for lead child tickets
but are hidden from New ticket. Stored tickets keep their workflow definition
and history even after its file is removed.

Workflows are YAML files named `<name>.yml`. Validate a directory with
`npm run kf -- check <dir>`.

Add a workflow by uploading its file on the Workflows page, or put it in the
factory's workflow directory and restart. Uploads cannot reuse a workflow
file's name; uploading an existing uploaded name creates a new version. To have
a model write one, give it `skills/kipster-workflows/SKILL.md`.

Remove an uploaded workflow with Remove on the Workflows page, or
`DELETE /api/workflows/<name>`. New tickets can no longer choose it. Workflow
files cannot be removed this way (409). While a queued, running or needs-you
ticket runs it, or an unfinished lead has a task that names it, removal is
refused (409) with those ticket numbers in `tickets`; finish or cancel them
first. Done and cancelled tickets keep their stored copy and history and still
open. Uploading the same name again adds it back.

## Ticket agent choices

Agent choices belong in Settings or a ticket creation request, never in workflow
YAML. `POST /api/tickets` accepts an optional `agents` object:

```json
{
  "repository": "owner/repository",
  "workflow": "lead",
  "title": "Build the feature",
  "agents": {
    "default": { "cli": "codex", "model": "gpt-6-astra", "effort": "high" },
    "roles": {
      "builder": { "cli": "codex", "model": "gpt-6.1-sol", "effort": "high" },
      "tester": { "cli": "claude", "model": "claude-opus-5-5" }
    },
    "reviewers": [
      { "cli": "codex", "model": "gpt-6-astra" },
      { "cli": "claude", "model": "claude-opus-5-5" }
    ]
  }
}
```

All three `agents` fields are optional. Each choice requires `cli` (`codex` or
`claude`); `model` and `effort` are optional. Unknown keys/roles/CLIs, empty model
names and invalid efforts return 400 with field-level `issues`. Model names are
passed to the CLI; the factory does not check model availability.

A role uses the ticket's role override, the lead's task agent (builder only),
the ticket default, the workflow's role override, the global role setting, then
the global default, in that order. Choices replace a whole agent choice rather
than mixing its CLI/model/effort with lower-priority choices. In the built-in
`lead`, planning uses role `lead`; `planner` is for workflows with a planner step.

Reviewer lists use ticket, workflow, then global settings. Omit `reviewers` to
inherit the list; send `[]` to use one reviewer selected by the role rules.
Only lead workflows use lists for parallel review. Independence checks still
apply and may replace a tester/reviewer that matches a builder, with a recorded
explanation, or require owner merging.

Responses return the supplied overrides as `ticket.agents` (null when omitted).
They are fixed at creation and survive restarts/retries. Lead children inherit
them, including separate-PR tasks; linked tickets in other repositories and
post-merge bug tickets do not. Unspecified choices keep following Settings,
which this request never changes. The creation UI has no override controls yet.

## Workflow fields

```yaml
name: sample # lowercase, digits and hyphens; matches the file name
description: One line saying what the workflow is for.
steps:
  - id: test # unique; not finish, cancel or ask
    kind: agent # agent | human | system
    role: tester # agent steps only
    needs: [verify] # capabilities the repository kit must provide
    instructions: Extra guidance for this step.
    limit: 3 # times this step may send the ticket back
    routes:
      changes-needed: build # outcome → step id or exit
      limit: ask # where to go once the limit is reached
```

System steps take an `action` and its parameters under `with`:

```yaml
- id: triage
  kind: system
  action: decide
  with:
    question: Is this a bug or a new feature?
    options:
      bug: Something that should work is broken
      feature: New or changed behaviour
    bands: { act: 0.9, confirm: 0.6 } # optional; confidence thresholds
  routes:
    bug: reproduce
    feature: plan
```

## Outcomes

| Step              | Outcomes (success first)               |
| ----------------- | -------------------------------------- |
| planner           | done                                   |
| builder           | done, needs-other-repo                 |
| tester, reviewer  | passed, changes-needed                 |
| reproducer        | reproduced, not-reproduced             |
| writer, onboarder | done                                   |
| human             | approved, changes-needed, rejected     |
| decide            | one per option; no success outcome     |
| maintain-pr       | ready, conflict, ci-failed, base-moved |
| merge             | merged, changes-needed, rejected       |
| lead              | done, delegate, plan-ready             |
| run-tasks         | reported                               |

Agent and system steps can also report `needs-decision`, which always pauses
the ticket for you unless routed.

`maintain-pr` waits only for required checks, so a non-required check may still
be running when the ticket reaches `merge`. If any check on the pull request
head fails while `merge` waits, `merge` reports `changes-needed` with the same
`CI failed: <name>` findings (link and log excerpt) that `ci-failed` carries.
New pull request review feedback also reports `changes-needed`. Route it to the
builder, or to the lead in a lead workflow; every built-in workflow does.

## Builder requests for another repository

`needs-other-repo` has factory behaviour before ordinary outcome routing. The
builder's `result.json` adds `otherRepository`:

```json
{
  "outcome": "needs-other-repo",
  "summary": "The caller needs the library API first.",
  "artifacts": [],
  "otherRepository": {
    "repository": "owner/library",
    "title": "Expose the library API",
    "body": "Describe the needed change and why the original ticket needs it.",
    "workflow": "lead"
  }
}
```

Repository, title and body are required and nonempty. `workflow` is optional,
with default `lead`; it must be a loaded workflow. Only builders can report
this request, and other outcomes must omit `otherRepository`. The target must be
another registered, ready repository with the workflow's capabilities. Invalid
results get the normal one fresh retry, then ask the owner; unregistered or
unavailable targets and workflows ask immediately. No link is opened on failure.

The system creates the linked ticket and parks the original builder attempt in
one transaction, unique per result attempt. The linked ticket follows its own
workflow, including its approval steps, and receives the original repository as
a read-only dependency. A confirmed merged PR on a done linked ticket queues the
same builder step in a fresh attempt with the original summary, request title/body,
PR URL and merge commit. Terminal links are checked at the merge-poll interval;
event wakes do not trigger extra polls. A cancelled
link, or completion without a confirmed merged PR, asks the owner. The parked
attempt survives restart and consumes no executor slot. Cancelling the original
does not cancel linked tickets.

## Lead tasks

Every task and the lead's final change are checked by another agent. The
built-in `task`, `task-pr` and `lead` testers declare no `needs`, so they run on
every repository. When the kit's verify instructions start the app, the tester
drives it; otherwise the tester checks the change itself in a disposable
checkout. A tester reports what it could not prove as artifacts with
`scenarioResult: unverified`; those are the ticket's **untested** reasons, and
the merge gate requires the owner for them. A task merged into the lead's branch
records the checker's verdict (passed, or its unverified items) in the task
report. Tickets that skipped a tester before this keep their stored skipped
steps and still read as untested. Reproducers and bug testers still require
`verify`.

A `lead` step's `delegate` must route to a `run-tasks` step, which runs the
tasks as child tickets and reports `reported` each time one finishes, fails,
conflicts or has a pull request ready. `run-tasks` takes optional `with`
parameters: `workflow` (default `task`) and `prWorkflow` (default `task-pr`)
for the two lands, `maxParallel` (default 3) and `maxTasks` (default 12).

A lead's `result.json` adds:

```json
{
  "outcome": "delegate",
  "summary": "Split into API and UI work",
  "artifacts": [],
  "tasks": [
    {
      "key": "api-export",
      "title": "Add the CSV export endpoint",
      "instructions": "Self-contained instructions for the task's agents.",
      "land": "branch",
      "workflow": "task",
      "agent": { "cli": "claude", "model": "opus", "effort": "high" }
    }
  ],
  "pullRequests": [{ "task": "docs-fix", "decision": "merge" }]
}
```

`tasks` only come with `delegate`. `pullRequests` come with `delegate`, or
with `done` when every decision is `leave-open`. `land` defaults to `branch`:
the task starts from the lead's branch and the system merges it back. A `pr`
task starts from the default branch and opens its own pull request; its
workflow must contain `maintain-pr` and `merge`, and a `branch` task's must
contain neither. `agent` must match an entry of `agents.allowed` in the
factory settings, and runs only the child's builder steps; its tester and
reviewer keep their own settings. `done` is refused while a task is still pending,
running or waiting for a decision.

## Defaults for unrouted outcomes

1. The success outcome continues to the next step, or finishes the ticket after
   the last step.
2. `rejected` cancels the ticket.
3. Anything else pauses the ticket and asks you.

## Exits

| Exit     | Effect                              |
| -------- | ----------------------------------- |
| `finish` | The ticket is done.                 |
| `cancel` | The ticket stops without finishing. |
| `ask`    | The ticket waits for you.           |

## Limits

`limit: n` counts only finished reports of the step with the same outcome that
would send the ticket back to itself or an earlier step, including the current
report. On the nth such report, the `limit` route applies instead (default:
`ask`). Passing reports, other outcomes, interrupted attempts and asks do not
consume that outcome's limit. Forward routes are never limited.
`maintain-pr` exempts `base-moved` from step limits: base synchronization has its
own `with.maxBaseSyncs` bound. Its `ci-failed` and `conflict` outcomes each have
an independent counter. The built-in workflows give `maintain-pr` a limit of 3;
`task-pr` cancels at the limit, while `lead`, `bug` and `onboard-repo` ask.
Give backward failure routes a limit so a lasting failure cannot loop forever.

### Ticket lights-out setting

`lightsOut` belongs to a ticket, not a workflow step. New tickets default it on
for `lead` and `program-lead` and off for other workflow names; existing tickets
stay off. Child tasks inherit it. On an enabled ticket, a lead's `plan-ready`
routed to the human step `approve-plan` is recorded as system-approved and
routes through its `approved` outcome. Keep the normal approval routes for
other tickets. Every agent is instructed to choose defaults and emit decision
artifacts with `kind: decision`, `title`, `chose`, `alternative` and `reason`
(no content/path). A child `needs-decision` parks that task and reports to the
lead while siblings continue. Parked tasks remain unfinished until resolved.
Role prompts keep their original wording when disabled. When enabled, product
questions choose and record defaults; necessary forbidden-path changes require
a separate explained commit and a passing review with `ownerReview` naming the
path and reason. Reproducers record alternative attempts before `not-reproduced`,
which still cannot start a fix. Only irreversible actions ask; other human steps,
limits and merge policy remain in effect.

## Concurrent testing and review

A tester immediately followed by a reviewer runs alongside that reviewer when
its `passed` route continues there (implicitly or explicitly). No step field is
needed. This applies to the built-in `lead`, `bug` and `task-pr` workflows,
and to any owner-defined workflow of that shape. The reviewer does not see
that round's tester evidence. The tester uses the running disposable app when
available, otherwise it checks the change in a disposable checkout. All
configured lead reviewers run as separate sessions. Each step has its own attempt, directories and logs.
The paired reviewer shares the tester's scheduler slot and timeout. Both
verdicts must match the pinned branch head. Both passes continue after review; a correction
wake carries both results and findings, only after both finish.

Each joined round retains both step results. Only matching send-back outcomes
count toward each step's limit; passing re-tests consume no limit.
Existing numeric limits and `limit` routes apply independently. When results
route differently, asks/cancellation win over backward correction routes, then
forward routes; the tester wins ties. A tester at its third failing round still
asks unless configured otherwise. A lead review at its fifth failing round
continues to `maintain-pr` when the tester passes; its unresolved findings still
prevent auto-merge. Execution errors wait for the sibling. If the survivor
reports `changes-needed`, its route and limit apply and the crashed side stays
failed with no verdict. Otherwise the pair asks at testing.
Cancellation interrupts both; crash recovery retries the whole pair once.
New branch commits invalidate both verdicts. Route `base-moved` to the tester
so that base synchronization starts a fresh pair.

## Reviewer lists, independence and rounds

Settings accepts global `agents.reviewers` (default `[]`) and optional
`workflows.<name>.reviewers` lists of agent choices. Lists have no length limit;
a ticket's `agents.reviewers` overrides both; otherwise a workflow list
overrides the global list. An empty list uses the reviewer
role setting. They are settings, not workflow fields. Lead workflows run the
selected list in parallel, each with its own log and result directory. Other
workflows retain a single reviewer. Use different CLI families (`claude` and
`codex`); same-family entries produce a warning.

Tester and reviewer choices must differ in CLI or model from every recorded
builder of the change, including child builders for a lead. Effort does not
make an agent independent. Candidates are tried in this order: ticket reviewer
list (reviewers only), ticket role override, ticket default, workflow
reviewer list (reviewers only), workflow role override, role setting, global
reviewers, allowed list, default. The engine records replacements. Without a
candidate it runs anyway, records the lack of independence, and requires the
owner to merge that head.

Review rounds use the existing step `limit`, defaulting to 5 when omitted.
Reviewers may therefore have a `limit` route without an explicit numeric limit;
other steps still require one. Matching send-backs include the current round, so
`limit: 5` permits exactly five failing rounds before taking the limit route.
The built-in lead routes `changes-needed` to `lead` and `limit` to `maintain-pr`:
open findings are published in the PR description and prevent auto-merge.
Every reviewer must pass at the current commit for the combined verdict to pass.
Passing reviewers' `ownerReview` reasons remain visible.

Lead review rounds after the first check earlier findings and problems added by
fixes. Findings may include optional `file`, a repository-relative path. A new
finding on a file unchanged since round one's commit becomes a note; earlier
findings, changed files and missing-file findings remain serious. Notes do not
route back to the lead.

## Partial results and evidence

A file artifact that cannot be retained becomes a note naming the file and
reason; the other artifacts and the step result are kept. The tester evidence
sweep keeps the newest 50 undeclared files by modification time per evidence
directory and adds one note with the omitted count. Declared artifacts and
instance logs are retained separately and do not consume this cap.

A failed or cancelled child task's report names its local branch and head
commit so the lead can reuse its work. The factory does not push that branch.
If the local branch is unavailable, the report says the head is unavailable.
