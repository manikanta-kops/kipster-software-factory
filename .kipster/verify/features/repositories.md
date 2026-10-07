# Repositories and onboarding

## Sub-features

- Registration from owner/name or clone URL; pending, ready and failed states.
- Kit status, validation errors and setup/verify capabilities.
- Capability-gated onboarding and opt-in auto-merge policy.

## How to get to it (user point of view)

Choose Repositories in the header. Choose New ticket to see how kit capabilities limit workflows.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                           | Exact command                                   | Observable result                                                                                                           |
| ----------------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Inspect repository states and kit errors              | `node .kipster/verify/drive.mjs repositories`   | The demo-shop kit is ready; invalid-kit shows verify.ready; legacy-api shows its clone failure.                             |
| Add a disposable repository record                    | `node .kipster/verify/drive.mjs register`       | A unique verification/map-* repository appears with Waiting for setup. No clone occurs.                                     |
| Enable auto-merge, reload, then restore it off        | `node .kipster/verify/drive.mjs policy`         | The checkbox survives reload and ends unchecked.                                                                            |
| Start onboarding for a repository with an invalid kit | `node .kipster/verify/drive.mjs gate-workflows` | bug is disabled because it needs a verified kit, lead stays enabled; Start onboard-repo ticket creates a queued kit ticket. |

## Gotchas

Seeded kit statuses are synthetic, not fetched validation of this kit. Scheduler-off registration remains pending. Do not register real remote repositories here. Auto-merge cannot execute with the scheduler disabled; actual policy and reconciliation are tested in tests/auto-merge.test.ts and tests/e2e/auto-merge.spec.ts. The owner reviews kit changes on the pull request.
