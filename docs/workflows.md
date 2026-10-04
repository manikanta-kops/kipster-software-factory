# Workflow format

Workflows are YAML files named `<name>.yml`. Validate a directory with
`npm run kf -- check <dir>`.

```yaml
name: feature # lowercase, digits and hyphens; matches the file name
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
| split             | done                                   |
| wait-children     | done, deferred                         |

Agent and system steps can also report `needs-decision`, which always pauses
the ticket for you unless routed.

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
