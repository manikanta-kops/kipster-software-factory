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

| Role         | Does                                                                       | Outcomes, success first        |
| ------------ | -------------------------------------------------------------------------- | ------------------------------ |
| `planner`    | Writes a plan with acceptance scenarios. Never commits.                    | `done`                         |
| `builder`    | The only author of product code. Implements, fixes conflicts and feedback. | `done`, `needs-other-repo`     |
| `tester`     | Runs the real app at the exact commit and returns a verdict with evidence. | `passed`, `changes-needed`     |
| `reproducer` | Proves a reported bug on the base branch before any fix.                   | `reproduced`, `not-reproduced` |
| `reviewer`   | Reads the diff once for serious problems the tester cannot see.            | `passed`, `changes-needed`     |
| `writer`     | Writes the pull request description.                                       | `done`                         |
| `onboarder`  | Writes a repository's `.kipster` kit.                                      | `done`                         |

Role notes:

- `tester` and `reproducer` start the app from the repository kit. Always give
  them `needs: [verify]`. Without it the file validates, but tickets on
  repositories without a verify kit fail at that step instead of being refused
  at creation.
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
- `needs-other-repo` is handled by the factory: it opens a linked ticket in
  the other repository and resumes the builder after that pull request merges.
  Do not route it.

## Actions (system steps)

| Action        | Does                                                                                               | `with`                                  | Outcomes, success first                        |
| ------------- | -------------------------------------------------------------------------------------------------- | --------------------------------------- | ---------------------------------------------- |
| `decide`      | Asks the decision model a typed question and routes on the chosen option.                          | `question`, `options`, optional `bands` | one per option; none is success                |
| `verify-kit`  | Proves the committed kit: setup, check and a running instance.                                     | none                                    | `passed`, `failed`                             |
| `maintain-pr` | Syncs with the base branch, publishes the pull request and waits for CI.                           | optional, see below                     | `ready`, `conflict`, `ci-failed`, `base-moved` |
| `merge`       | Merges when the repository allows auto-merge and every rule passes; otherwise waits for the owner. | none                                    | `merged`, `changes-needed`, `rejected`         |

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

Action notes:

- `maintain-pr` is the only way a pull request gets published. Put it before
  `merge`.
- After `maintain-pr` merges the base, a tester verdict must match the new
  commit. Route `base-moved` back to the tester step. Without a tester, it is
  not reported.
- `merge` merges by itself only when the owner turned on auto-merge for the
  repository, the latest `tester` and `reviewer` both passed at the exact pull
  request head, and no rule needs the owner. Migrations, kit and CI changes
  always need the owner. Otherwise the owner merges on GitHub, and owner
  review comments report `changes-needed`.

## Human steps

Outcomes: `approved` (success), `changes-needed`, `rejected`. Route
`changes-needed` back to the step that should redo the work. Human steps
cannot report `needs-decision` or declare `needs`.

## Capabilities

| Capability | The repository kit provides                   | Needed by                     |
| ---------- | --------------------------------------------- | ----------------------------- |
| `setup`    | An install or setup command.                  | steps that must install first |
| `verify`   | A way to start the app and check it is ready. | `tester`, `reproducer`        |

A ticket cannot start on a repository whose kit lacks a capability the
workflow needs. List only what a step really uses, so the workflow works on
as many repositories as possible.

## Routing

Each route key must be an outcome the step can report, `needs-decision`
(agent and system steps), or `limit` (only when the step has a `limit`). Each
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

Typical limits: tester 3, reviewer 2, verify-kit 3. Human steps rarely need
one because the owner is already in the loop.

## Design rules

These come from failures seen in practice. Follow them unless the request
explicitly says otherwise, and then say which rule you broke and why.

- **Prove, do not claim.** A workflow that changes product code should have a
  `tester` before `maintain-pr`. Without one, the merge gate never reports the
  pull request ready.
- **Nothing judges its own work.** Testing and review are separate steps from
  building.
- **Reproduce before fixing.** Bug workflows start with a `reproducer`.
- **Agree the outcome first.** Put a human approval after the planner when the
  work is new or unclear.
- **Route on typed outcomes.** Use `decide` to branch on unstructured input,
  never instructions that ask an agent to "pick a path".
- **Every loop has a limit,** and the limit leads somewhere useful: `ask` by
  default, or an explicit forward step.
- **Review once.** A reviewer limit of 2 is enough.
- **Test and review for auto-merge.** A workflow without both a `tester` and a
  `reviewer` always waits for the owner to merge.
- **Agents propose, the system acts.** Never use `instructions` to tell an
  agent to push, open a pull request or merge.
- **Instructions refine a role; they do not change it.** They are appended to
  the role's own prompt. Keep them short and specific to this workflow. Do not
  ask a reviewer or tester to edit code, or a planner to commit.

## Built-in workflows

Use these as patterns. Prefer adapting one over starting from nothing.

`feature`: plan, approve, build, test, review, publish, merge.

```yaml
name: feature
description: Agree a plan with you, build it, prove it in the running app and land it.
steps:
  - id: plan
    kind: agent
    role: planner

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
    needs: [verify]
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

`quick-change` is `feature` without the tester, for repositories with no
verify kit. `onboard-repo` is write-kit (onboarder), verify-kit (limit 3,
`failed` back to write-kit), approve-kit, maintain-pr, merge.

An example that branches with `decide`: the planner writes a plan, then the
decision model chooses whether the owner must approve it.

```yaml
name: feature-fast-lane
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
    needs: [verify]
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
- **Files:** a workflow file in the factory's workflow directory loads at
  startup. The built-in `feature`, `bug`, `quick-change` and `onboard-repo`
  are files, so uploads cannot reuse those names.

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
      `limit` with a `limit` set.
- [ ] Every route target is a step id or `finish`, `cancel`, `ask`.
- [ ] Every backwards route sits on a step with a `limit`.
- [ ] `tester` and `reproducer` steps have `needs: [verify]`.
- [ ] Every `decide` option is routed.
- [ ] A workflow with a `reproducer` has no path that reaches a `tester`
      without reproducing first.
- [ ] Product code changes pass through `maintain-pr` before `merge`.
- [ ] Following the success outcomes from the first step reaches the end.

When you have the factory repository, validate a directory of workflows:

```sh
npm run kf -- check <directory>
```

It prints each error with the file and step, or how many workflows are valid.
