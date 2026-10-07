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

Only child tickets running `task` or `task-pr` may skip a tester whose declared
capabilities are missing. The catalog defines this exception; no step field
enables it. The ticket durably records the skip as **untested**, and routes
continue at the next step in file order. Routes targeting the skipped tester
also continue there. Top-level tickets, other workflows and reproducers still
require every declared capability. Untested task PRs and lead PRs containing
merged untested tasks require owner merging.

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

`limit: n` caps how many times a step may send the ticket back to itself or an
earlier step. When the step has run `n` times and would send it back again, the
`limit` route applies instead (default: `ask`). Forward routes are never
limited.

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

## Reviewer lists, independence and rounds

Settings accepts global `agents.reviewers` (default `[]`) and optional
`workflows.<name>.reviewers` lists of agent choices. Lists have no length limit;
a workflow list overrides the global list, and an empty list uses the reviewer
role setting. They are settings, not workflow fields. Lead workflows run the
selected list in parallel, each with its own log and result directory. Other
workflows retain a single reviewer. Use different CLI families (`claude` and
`codex`); same-family entries produce a warning.

Tester and reviewer choices must differ in CLI or model from every recorded
builder of the change, including child builders for a lead. Effort does not
make an agent independent. Candidates are tried in this order: workflow
reviewer list (reviewers only), workflow role override, role setting, global
reviewers, allowed list, default. The engine records replacements. Without a
candidate it runs anyway, records the lack of independence, and requires the
owner to merge that head.

Review rounds use the existing step `limit`, defaulting to 5 when omitted.
Reviewers may therefore have a `limit` route without an explicit numeric limit;
other steps still require one. Finished runs include the current round, so
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
