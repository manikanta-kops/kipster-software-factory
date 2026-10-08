---
name: kipster-workflows
description: Write or review a Kipster Software Factory workflow, the YAML file that tells the factory which agent, human and system steps a ticket runs and how outcomes route between them. Use when asked to create, change, explain or check a factory workflow.
---

# Writing Kipster factory workflows

The Kipster Software Factory turns tickets into verified pull requests. Each
ticket runs one **workflow**: an ordered list of steps. Each step reports one
typed **outcome**. **Routes** map outcomes to the next step.

Your job is to produce one valid workflow file. The owner uploads it on the
factory's Workflows page, which validates it before saving.

## What to deliver

- Exactly one YAML document, saved as `<name>.yml`.
- `name` inside the file must equal the file name without `.yml`. An upload
  only reads `name`, but workflow files on disk must match.
- No other files. You cannot add roles, actions, capabilities or step fields.
  If the request needs one, say so instead of inventing it.
- After the file, give a short list: the path a ticket takes when everything
  passes, each loop and its limit, and every place a human is asked.

## File shape

```yaml
name: build-and-test # required; lowercase letters, digits, hyphens; starts with a letter
description: Build the change and prove it in the running app. # required; one line
steps: # required; at least one step, run top to bottom
  - id: build # required; unique; same slug rules as name
    kind: agent # required; agent | human | system
    role: builder # agent steps only

  - id: test
    kind: agent
    role: tester
    needs: [verify] # agent and system steps; capabilities the repository kit must provide
    instructions: Cover the empty state as well. # optional; non-empty text
    limit: 3 # optional; positive integer; caps how often this step sends the ticket back
    routes: # optional; outcome -> step id or exit
      changes-needed: build
      limit: ask
```

System steps add `action` and optional `with` parameters:

```yaml
- id: maintain-pr
  kind: system
  action: maintain-pr
  with:
    ciTimeoutMinutes: 60
  routes:
    conflict: build
```

Any other key is an error. Step ids `finish`, `cancel` and `ask` are reserved.

### Which keys each kind takes

| Key            | agent    | human    | system     |
| -------------- | -------- | -------- | ---------- |
| `role`         | required | no       | no         |
| `action`       | no       | no       | required   |
| `with`         | no       | no       | per action |
| `needs`        | optional | no       | optional   |
| `instructions` | optional | optional | optional   |
| `limit`        | optional | optional | optional   |
| `routes`       | optional | optional | optional   |

## Step kinds

- **agent**: a fresh AI session with a fixed role. It reads the ticket, prior
  step summaries, artifacts and the branch. It never sees an earlier
  conversation.
- **human**: the ticket waits in the owner's "Needs you" list. The owner
  approves, asks for changes with a comment, or rejects.
- **system**: the factory does fixed work itself, such as publishing the pull
  request. Only system steps push, open pull requests or merge.

## Roles (agent steps)

| Role         | Does                                                                       | Outcomes, success first          |
| ------------ | -------------------------------------------------------------------------- | -------------------------------- |
| `planner`    | Writes a plan with acceptance scenarios. Never commits.                    | `done`                           |
| `builder`    | The only author of product code. Implements, fixes conflicts and feedback. | `done`, `needs-other-repo`       |
| `tester`     | Checks the exact commit, in the running app when the kit starts one.       | `passed`, `changes-needed`       |
| `reproducer` | Proves a reported bug on the base branch before any fix.                   | `reproduced`, `not-reproduced`   |
| `reviewer`   | Reads the diff once for serious problems the tester cannot see.            | `passed`, `changes-needed`       |
| `writer`     | Writes the pull request description.                                       | `done`                           |
| `onboarder`  | Writes a repository's `.kipster` kit.                                      | `done`                           |
| `lead`       | Splits the ticket into tasks run as child tickets; decides from reports.   | `done`, `delegate`, `plan-ready` |

Role notes:

- With lights-out off, ticket and approved-plan scope also govern linked
  documentation. Builders leave explicitly forbidden paths untouched and note
  inaccurate documents;
  if the conflict prevents the requested change, they report `needs-decision`.
  Reviewers report `changes-needed` for forbidden-path edits. An `ownerReview`
  flag does not authorize expanded scope.
- With lights-out off, agents report `needs-decision` only for a product question
  that the ticket, the repository and sensible defaults cannot answer. They solve tools,
  runtimes and in-scope kit changes themselves, and name any check they could
  not run in their summary instead of stopping. The owner reviews on the pull
  request.
- A `tester` always runs. When the repository kit has `verify` and the app
  starts, the factory starts it at the exact commit and the tester drives it.
  Otherwise the tester gets only a disposable checkout and works out how to
  check the change itself: it reads the diff, installs, runs the tests and may
  start the app. A failed app start is told to the tester; it does not fail
  the step. Give a feature tester no `needs`, so it runs on every repository.
- A `reproducer` and a bug `tester` (see below) need the running app. Always
  give them `needs: [verify]`. Without it the file validates, but tickets on
  repositories without a verify kit fail at that step instead of being refused
  at creation.
- A tester returns `passed` when nothing it checked failed. Each scenario it
  could not prove is reported as unverified; that is not `changes-needed`.
  Unverified items mean **untested**: the merge gate, the PR description and
  the ticket list them, and the merge gate requires the owner. A lead's task
  report carries each task's checker verdict: passed, or its unverified items.
- When a workflow contains any `reproducer` step, every `tester` in it is a
  bug tester. It fails unless a reproduction succeeded first, and the merge
  gate requires that reproduction. So never mix bug and feature paths in one
  workflow. Write two workflows and let the owner pick.
- A `tester` uses the planner's acceptance scenarios. A workflow with a tester
  and no planner should have a reproducer, or the tester has nothing agreed to
  prove.
- Do not add a `writer` step. `maintain-pr` runs the writer itself before it
  publishes.
- Use `onboarder` only in a workflow that writes the kit, followed by
  `verify-kit`.
- Kit setup and check run in disposable exact-commit checkouts with fetched
  remote-tracking base refs (for example `origin/next`) and no configured remote.
  Repository gates can compare changesets, migrations and protocol shapes with
  these base snapshots without fetching or using shared development state.
- `needs-other-repo` is handled by the factory: it opens a linked ticket in
  the other repository and resumes the builder after that pull request merges.
  Its optional `otherRepository.workflow` defaults to `lead`. Do not route it.
- A `lead` never commits. `delegate` hands out tasks and must route to a
  `run-tasks` step; the validator rejects a lead without that route.
  `plan-ready` comes with a plan; route it to a human step whose `approved`
  and `changes-needed` both route back to the lead. `done` means every task
  has finished; route it forward to the final tester. Route the final
  tester's, reviewer's and `maintain-pr`'s failures back to the lead, which
  fixes them with new tasks.

## Actions (system steps)

| Action        | Does                                                                                               | `with`                                  | Outcomes, success first                        |
| ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `decide`      | Asks the decision model a typed question and routes on the chosen option.                          | `question`, `options`, optional `bands` | one per option; none is success                |
| `verify-kit`  | Proves the committed kit: setup, check and a running instance.                                     | none                                    | `passed`, `failed`                             |
| `maintain-pr` | Syncs with the base branch, publishes the pull request and waits for CI.                           | optional, see below                     | `ready`, `conflict`, `ci-failed`, `base-moved` |
| `merge`       | Merges when the repository allows auto-merge and every rule passes; otherwise waits for the owner. | none                                    | `merged`, `changes-needed`, `rejected`         |
| `run-tasks`   | Runs a lead's tasks as child tickets and reports each time one finishes.                           | optional, see below                     | `reported`                                     |

`decide` parameters:

```yaml
- id: needs-approval
  kind: system
  action: decide
  with:
    question: Does this ticket need the owner to approve the plan? # non-empty
    options: # at least two; keys are slugs; values describe each option
      approve: New behaviour, product choices or unclear scope
      skip: Small, fully specified change
    bands: { act: 0.9, confirm: 0.6 } # optional; 0..1; confirm <= act
  routes:
    approve: approve-plan
    skip: build
```

At or above `act` the answer routes directly. Between `confirm` and `act` the
owner confirms with one click. Below `confirm`, or without a decision key, the
owner chooses. The model sees facts (paths, diff statistics, verdicts, CI),
never an agent's prose. Route every option: `decide` has no success outcome,
so an unrouted option pauses the ticket.

`maintain-pr` parameters, all optional:

| Parameter          | Default | Meaning                                                                                |
| ------------------ | ------- | -------------------------------------------------------------------------------------- |
| `ciTimeoutMinutes` | 60      | How long to wait for CI before asking the owner.                                       |
| `ciSettleMinutes`  | 3       | How long to wait after a push for CI to register before treating "no checks" as final. |
| `maxBaseSyncs`     | 3       | How many base-branch moves in a row it syncs and re-tests before asking the owner.     |

`run-tasks` parameters, all optional:

| Parameter     | Default   | Meaning                                                    |
| ------------- | --------- | ---------------------------------------------------------- |
| `workflow`    | `task`    | Workflow for tasks that land on the lead's branch.         |
| `prWorkflow`  | `task-pr` | Workflow for tasks that land as their own pull request.    |
| `maxParallel` | 3         | How many tasks run at once. Queued tasks start in order.   |
| `maxTasks`    | 12        | How many tasks one ticket may ask for over its whole life. |

Action notes:

- `run-tasks` only works as the target of a lead's `delegate`; the validator
  rejects it anywhere else. Route `reported` back to the lead, and give the
  step a `limit`: every report is one more lead session.
- A task's workflow is checked when the lead asks for it, not at upload. A
  task that lands on the lead's branch must not contain `maintain-pr` or
  `merge`: the system merges it into the lead's branch when it finishes. A
  task that lands as a pull request must contain both. Task workflows cannot
  contain a `lead`. Give their backwards routes `limit: cancel`, so a stuck
  task reports `failed` to the lead instead of waiting for the owner.
- At runtime, two or more `failed` tasks with the same error after removing
  paths, IDs, hashes, timestamps, durations and numbers form a repeated failure.
  `conflict` is excluded. The lead context adds `repeatedFailure` groups with
  signature, count and task keys; the Task report names the count and keys.
  Delegation rejects instructions equal after whitespace normalisation to any
  task in a group, using the usual invalid-result retry. In both modes the lead
  must classify the cause as `task` (instructions), `plan` (split or order) or
  `factory` (engine, CLI, runtime or machine), record a typed `decision` artifact
  with `title`, `chose`, `alternative` and `reason` (no content/path), then change
  the task or plan, or stop retrying that line, name it in the summary and
  continue the rest. Changed instructions are allowed. In default mode a factory
  cause without a workaround may report `needs-decision`.
- A pull request task's `merge` waits for the lead: it merges only after the
  lead chooses `merge`, and then only under the normal auto-merge rules.
- A lead may give a task an `agent` from the factory's allowed list. It runs
  only the task's `builder` steps; the task's `tester`, `reviewer` and `writer`
  keep the factory settings, so review can come from another model family.
- A workflow file never names an agent, model or timeout. The owner sets those
  on the factory's Settings page, globally or per workflow name. An agent step
  runs with, in order: the task's agent (builder steps only), the workflow's
  override for the role, the factory's role setting, then its default. The step
  timeout is the workflow's override, then the factory's (120 minutes unless
  changed).
- `maintain-pr` is the only way a pull request gets published. Put it before
  `merge`. It waits only for the repository's required checks (all checks when
  none are required). Any check that has already failed, required or not,
  reports `ci-failed` with its name, link and log excerpt; a non-required check
  still running is not awaited. Route `ci-failed` to the builder, or to the
  lead in a lead workflow. Under lights-out the builder puts a fix outside the
  ticket's scope in its own commit and flags it for the owner.
- After `maintain-pr` merges the base, prior tester and reviewer verdicts must
  match the new commit. Route `base-moved` back to the tester step, followed by
  review. Without a tester, route it to review. With neither prior verdict,
  it is not reported. A saved workflow without this route asks the owner.
- `merge` merges by itself only when the owner turned on auto-merge for the
  repository, the latest `tester` and `reviewer` both passed at the exact pull
  request head, and no rule needs the owner. Migrations, kit and CI changes
  always need the owner. Otherwise the owner merges on GitHub, and owner
  review comments report `changes-needed`. A check on the pull request head
  that fails while `merge` waits, such as a non-required check that was still
  running at `ready`, also reports `changes-needed` with the same
  `CI failed: <name>` findings as `ci-failed`. Route `merge`'s
  `changes-needed` to the builder, or to the lead in a lead workflow.

## Human steps

Outcomes: `approved` (success), `changes-needed`, `rejected`. Route
`changes-needed` back to the step that should redo the work. Human steps
cannot report `needs-decision` or declare `needs`.

## Capabilities

| Capability | The repository kit provides                   | Needed by                     |
| ---------- | --------------------------------------------- | ----------------------------- |
| `setup`    | An install or setup command.                  | steps that must install first |
| `verify`   | A way to start the app and check it is ready. | `reproducer`, bug `tester`    |

A ticket cannot start on a repository whose kit lacks a capability the
workflow needs. List only what a step really uses, so the workflow works on
as many repositories as possible.

## Routing

Each route key must be an outcome the step can report, `needs-decision`
(agent and system steps), or `limit` (when the step has a `limit`, or is a reviewer with the default 5). Each
target must be a step id in this file or an exit.

### Exits

| Exit     | Effect                              |
| -------- | ----------------------------------- |
| `finish` | The ticket is done.                 |
| `cancel` | The ticket stops without finishing. |
| `ask`    | The ticket waits for the owner.     |

### Defaults for unrouted outcomes

1. The success outcome goes to the next step, or finishes after the last step.
2. `rejected` cancels the ticket.
3. `needs-decision` and everything else ask the owner.

So most steps need routes only for their non-success outcomes. Do not write
routes that repeat a default.

### Limits

`limit: n` counts finished runs of the step. When the step has run `n` times
and an outcome would send the ticket back to itself or an earlier step, the
`limit` route applies instead. Its default is `ask`. Forward routes are never
limited. Every route that goes backwards should sit on a step with a `limit`,
or a lasting failure loops until the owner notices.

Typical limits: tester 3, lead reviewer 5, other reviewer 2, verify-kit 3. Human steps rarely need
one because the owner is already in the loop.

## Design rules

These come from failures seen in practice. Follow them unless the request
explicitly says otherwise, and then say which rule you broke and why.

- **Prove, do not claim.** A workflow that changes product code should have a
  `tester` before `maintain-pr`. Without one, a ready merge gate still requires
  the owner with the reason `Untested workflow`. When the tester reports
  unverified items, the owner merges too.
- **Nothing judges its own work.** Testing and review are separate steps from
  building.
- **Reproduce before fixing.** Bug workflows start with a `reproducer`.
- **Agree the outcome first.** Put a human approval after the planner when the
  work is new or unclear.
- **Route on typed outcomes.** Use `decide` to branch on unstructured input,
  never instructions that ask an agent to "pick a path".
- **Every loop has a limit,** and the limit leads somewhere useful: `ask` by
  default, or an explicit forward step.
- **Bound review.** Lead review defaults to five rounds; later rounds check earlier fixes.
- **Test and review for auto-merge.** A workflow without both a `tester` and a
  `reviewer` always waits for the owner to merge.
- **Agents propose, the system acts.** Never use `instructions` to tell an
  agent to push, open a pull request or merge.
- **Instructions refine a role; they do not change it.** They are appended to
  the role's own prompt. Keep them short and specific to this workflow. Do not
  ask a reviewer or tester to edit code, or a planner to commit.

## Built-in workflows

New ticket offers `bug`, `lead` and `onboard-repo`, plus uploaded workflows.
`lead` covers features and small changes. `task` and `task-pr` remain built-ins
for child tickets delegated by leads; New ticket hides them.
Use these as patterns. Prefer adapting one over starting from nothing.

`bug`: reproduce, fix, prove base fails and branch passes, review, publish,
merge.

```yaml
name: bug
description: Reproduce the bug first, fix it, prove the fix in the running app and land it.
steps:
  - id: reproduce
    kind: agent
    role: reproducer
    needs: [verify]

  - id: fix
    kind: agent
    role: builder

  - id: test
    kind: agent
    role: tester
    needs: [verify]
    instructions: Show the reproduction failing on the base branch and passing on this branch.
    limit: 3
    routes:
      changes-needed: fix

  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: fix

  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: fix
      ci-failed: fix
      base-moved: test

  - id: merge
    kind: system
    action: merge
    routes:
      changes-needed: fix
```

`lead`: a lead splits the ticket into tasks, `run-tasks` runs them and wakes
the lead after each one, then the whole change is tested, reviewed and landed.

```yaml
name: lead
description: A lead agent splits the ticket into tasks that run as child tickets, then the whole change is tested, reviewed and landed.
steps:
  - id: lead
    kind: agent
    role: lead
    routes:
      plan-ready: approve-plan
      delegate: run-tasks
      done: final-test

  - id: approve-plan
    kind: human
    routes:
      approved: lead
      changes-needed: lead

  - id: run-tasks
    kind: system
    action: run-tasks
    with:
      maxParallel: 3
      maxTasks: 20
    limit: 50
    routes:
      reported: lead

  - id: final-test
    kind: agent
    role: tester
    instructions: Test the whole change against the ticket and the approved plan, not one task.
    limit: 3
    routes:
      changes-needed: lead

  - id: review
    kind: agent
    role: reviewer
    limit: 5
    routes:
      changes-needed: lead
      limit: maintain-pr

  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: lead
      ci-failed: lead
      base-moved: final-test

  - id: merge
    kind: system
    action: merge
    routes:
      changes-needed: lead
```

The tasks run `task` (lands on the lead's branch) or `task-pr` (its own pull
request):

```yaml
name: task
description: One task from a lead, built and tested on its own branch. The system merges it into the lead's branch when it passes.
steps:
  - id: build
    kind: agent
    role: builder

  - id: test
    kind: agent
    role: tester
    limit: 3
    routes:
      changes-needed: build
      limit: cancel
```

```yaml
name: task-pr
description: One task from a lead that lands as its own pull request. The lead decides whether the system merges it.
steps:
  - id: build
    kind: agent
    role: builder

  - id: test
    kind: agent
    role: tester
    limit: 3
    routes:
      changes-needed: build
      limit: cancel

  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build
      limit: cancel

  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: build
      ci-failed: build
      base-moved: test

  - id: merge
    kind: system
    action: merge
    routes:
      changes-needed: build
```

`onboard-repo` is write-kit (onboarder), verify-kit (limit 3,
`failed` back to write-kit), approve-kit, maintain-pr, merge.

An example that branches with `decide`: the planner writes a plan, then the
decision model chooses whether the owner must approve it.

```yaml
name: change-fast-lane
description: Plan, let the decision model skip plan approval for small clear changes, then build, prove and land it.
steps:
  - id: plan
    kind: agent
    role: planner

  - id: needs-approval
    kind: system
    action: decide
    with:
      question: Does this ticket need the owner to approve the plan before building?
      options:
        approve: New behaviour, product or design choices, or unclear scope
        skip: Small, fully specified change with no product choices
      bands: { act: 0.95, confirm: 0.7 }
    routes:
      approve: approve-plan
      skip: build

  - id: approve-plan
    kind: human
    routes:
      changes-needed: plan

  - id: build
    kind: agent
    role: builder

  - id: test
    kind: agent
    role: tester
    limit: 3
    routes:
      changes-needed: build

  - id: review
    kind: agent
    role: reviewer
    limit: 2
    routes:
      changes-needed: build

  - id: maintain-pr
    kind: system
    action: maintain-pr
    routes:
      conflict: build
      ci-failed: build
      base-moved: test

  - id: merge
    kind: system
    action: merge
    routes:
      changes-needed: build
```

Order matters: success moves to the next step in the file. Here `skip` routes
past `approve-plan` explicitly.

## Adding it to the factory

- **Upload:** on the Workflows page, choose "Upload workflow" and pick the
  file. The factory validates it, lists every error, and saves it only when it
  is valid. It is available for new tickets at once and survives restarts.
- **API:** `POST /api/workflows` with JSON `{ "source": "<the YAML text>" }`.
  It answers 201 for a new name, 200 for a new version of an uploaded name,
  400 with `issues` when invalid, and 409 for a name owned by a workflow file.
- **Remove:** Remove on the Workflows page, or `DELETE /api/workflows/<name>`,
  takes an uploaded workflow out of the library. It is refused (409) for a
  workflow file, and while a ticket that is not done or cancelled runs it or an
  unfinished lead has a task naming it; the refusal lists those ticket numbers.
  Done and cancelled tickets keep their copy. Upload it again to add it back.
- **Files:** a workflow file in the factory's workflow directory loads at
  startup. The built-in `bug`, `lead`, `onboard-repo`,
  `task` and `task-pr` are files, so uploads cannot reuse those names.

## Versions

The factory stores each workflow by a hash of its content. Uploading the same
name again, or editing a file, creates a new version. Running tickets keep the
version they started with. Keep the `name` when you change a workflow; a new
name is a new workflow.

## Checking a file

Before you hand it over, check:

- [ ] `name` matches the file name and is a slug.
- [ ] Every step has a unique slug `id` and only the keys its kind allows.
- [ ] Every route key is an outcome the step can report, `needs-decision`, or
      `limit` with a `limit` set (or a reviewer with the default limit).
- [ ] Every route target is a step id or `finish`, `cancel`, `ask`.
- [ ] Every backwards route sits on a step with a `limit`.
- [ ] `reproducer` steps and bug `tester` steps have `needs: [verify]`.
- [ ] Every `decide` option is routed.
- [ ] A workflow with a `reproducer` has no path that reaches a `tester`
      without reproducing first.
- [ ] Product code changes pass through `maintain-pr` before `merge`.
- [ ] Every `lead` routes `delegate` to a `run-tasks` step whose `reported`
      routes back to that lead and which has a `limit`.
- [ ] Following the success outcomes from the first step reaches the end.

When you have the factory repository, validate a directory of workflows:

```sh
npm run kf -- check <directory>
```

It prints each error with the file and step, or how many workflows are valid.

## Ticket lights-out

`lightsOut` is a ticket setting; do not add a workflow or step field. It defaults
on for new tickets using workflow names `lead` and `program-lead`, off for other
names; existing tickets stay off. Children inherit it. For an enabled ticket,
a lead's `plan-ready` routed to a human step named `approve-plan` is approved
by the system with a recorded event, then follows `approved`. Keep that route
back to the lead; its next prompt has `planApproved: true`. Other human steps
and workflow limits still wait normally.

Every enabled agent prompt says to choose sensible defaults and continue,
recording each choice as a decision artifact with `kind: decision`, `title`,
`chose`, `alternative` and `reason` (three nonempty strings, no content/path).
These are agent choices, separate from the `decide` action's model judgements.
Irreversible actions wait: merging outside merge policy, deleting data or
force-pushing. Only system actions publish or merge. Kit, CI, migrations and
reviewer `ownerReview` still require the owner.

Base role wording stays unchanged when lights-out is off. When on, builders,
planners, testers, leads and onboarders choose and record defaults for product
questions and continue with their normal outcomes. A builder who must change an
explicitly forbidden path does so in its own separate commit, states the path
and reason in the commit message and summary, and records a decision artifact.
An otherwise correct change passes review with `ownerReview` naming that path
and the builder's reason; scope alone does not block that explained commit.
Reproducers try other entry points, inputs, data states and conditions and record
every attempt before returning `not-reproduced`. The workflow still routes that
outcome; it must never start a fix. Onboarders continue without asking for kit
changes; the owner reviews them on the PR and normal kit approval still applies.

For an enabled lead, a child `needs-decision` becomes a `parked` task and wakes
the lead with its summary. Siblings continue, and queued work can use the freed
parallel slot. Parked tasks remain unfinished: the lead can delegate while
waiting but cannot report `done`. Owner retry or move resumes the child; its
finish is reported normally. Cancelling the lead cancels parked children too.
With lights-out off, the original approval and reporting behaviour applies.

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

Each joined round counts one finished run for each step, even when it passes.
Existing numeric limits and `limit` routes apply independently. When results
route differently, asks/cancellation win over backward correction routes, then
forward routes; the tester wins ties. A tester at its third failing round still
asks unless configured otherwise. A lead review at its fifth failing round
continues to `maintain-pr` when the tester passes; its unresolved findings still
prevent auto-merge. Execution errors wait for the sibling, then ask at testing.
Cancellation interrupts both; crash recovery retries the whole pair once.
New branch commits invalidate both verdicts. Route `base-moved` to the tester
so that base synchronization starts a fresh pair.

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

## Ticket summaries and lessons

The factory records a fact-based summary when a ticket finishes, is cancelled,
or needs the owner. This is lifecycle bookkeeping, not a workflow step.
It does not need an action or extra step fields. The same transaction proposes
one-line lessons from reviewer finding titles repeated across at least two
`changes-needed` rounds, repeated recorded attempt errors (including children) and system-recorded task
startup/integration errors,
and human `changes-needed` or `rejected` comments. Agent summaries and task
result prose are never lesson sources. CLI crashes and result.json validation
failures belong to the engine; other lessons belong to the ticket repository.
Review findings are aggregated within a ticket, not across tickets.

Lessons never change ticket status, waiting state or routes. The owner accepts
or rejects proposals in Today and retires accepted lessons in Repositories with
a reason, such as "replaced by check X". Rejected and retired keys stay suppressed.
A repository may accept at most 30 lessons; accepting another requires retirement
first. Engine lessons have no cap. Lesson text is at most 200 characters on one
line. Dedup keys use normalised source facts bounded to 240 characters.

Before every agent invocation, including parallel reviewers, proof and PR
writers, the factory writes `lessons.md` in that invocation's directory outside
the repository. It lists accepted repository lessons first, then engine lessons.
The prompt adds exactly `Past mistakes in this repository: <absolute path>. Read
it when planning or when stuck.` Lesson text is not inserted into the prompt.
With no accepted lessons there is no file or pointer. Owner decisions affect the
next invocation; existing prompts keep their snapshot. Retire lessons once a
check prevents the mistake.
