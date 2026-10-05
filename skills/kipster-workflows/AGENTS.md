# Keeping the workflow skill current

`SKILL.md` teaches a model with no access to this repository to write a valid
workflow file. It must match what the factory accepts and how it runs a
ticket. A stale guide produces files that fail validation or fail at runtime.

## Update SKILL.md in the same change when you

- Add, remove or rename a role, action, capability, exit or outcome in
  `src/domain/catalog.ts`.
- Change an action's `with` parameters or their defaults.
- Change workflow parsing or validation in `src/domain/workflow.ts`.
- Change routing defaults or limit counting in `src/domain/routing.ts`.
- Change how the engine treats a role or action in a way an author must design
  around, such as required capabilities, implied ordering or merge gate facts.
- Change a built-in workflow in `workflows/` that SKILL.md quotes.
- Change how workflows are added to the factory, such as an upload in the UI.

## Rules

- Keep it self-contained. The reader cannot open other files in this
  repository.
- State what the validator rejects and what only fails at runtime separately.
- Every complete YAML example must be a valid workflow.
  `tests/workflow-skill.test.ts` parses each one and checks that every catalog
  role, action, capability, exit and outcome is named.
- Write for a model: short sentences, tables for fixed lists, one term per
  concept.
