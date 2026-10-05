# Kipster Software Factory

The factory turns tickets into verified pull requests. A ticket runs a workflow
of agent, human and system steps; routes move it between steps; a repository's
`.kipster/` kit tells agents how to build, run and verify that repository.

Read [the architecture](docs/architecture.md) before changing behaviour and
[the workflow guide](docs/workflow-guide.md) before changing workflows or roles.

## Working rules

- Understand the requested outcome and the existing code first. Keep changes
  focused; build the thinnest end-to-end slice before widening it.
- Challenge assumptions and look for failure cases before implementing. Raise
  material gaps with a proposed way forward.
- Never claim something works without running it. Report what you ran, the
  results and what is still unverified.
- Keep `src/domain/` pure: no I/O, no Node APIs. It must stay importable by the
  web app.
- The step schema is deliberately small. Add behaviour through the catalog
  (`src/domain/catalog.ts`: roles, actions, capabilities), not new step fields.
  Action parameters go under `with`.
- Agents propose; system steps act. Only system actions push, open pull
  requests or merge.
- Migrations in `src/store/migrations/` are append-only once merged into
  `next`: add a new numbered file, never edit a shipped one.
- API responses change by addition only; shared shapes live in
  `src/api/contract.ts`.
- Test against real PostgreSQL, never a mock. Use the browser tests for UI
  behaviour.
- Comments explain only a non-obvious why. Prefer clear names.
- Changes to workflows, the catalog, routing or how an action behaves must
  update `skills/kipster-workflows/SKILL.md`. See its `AGENTS.md`.

## Before finishing

```sh
npm run check && npm test && npm run test:e2e
```

## Branches and pull requests

Start from the latest `origin/next` on a new branch, in its own worktree when
other work may share the checkout. Open pull requests against `next`. The owner
merges. `master` holds released versions and only the owner merges into it.
