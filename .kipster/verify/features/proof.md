# Proof, merge readiness and evidence

## Sub-features

- Latest tester verdict with commit link and stale-state display.
- Merge gate, earlier green head and owner rules.
- Scenario index, stable evidence route, image viewer, video and lazy logs.
- A failed non-required CI check routed back to build, and a pending one not awaited.
- Running logs, failure findings, pruned rows and live CI transitions (separate fixtures).

## How to get to it (user point of view)

On Today open Cart quantity changes are proven or Cart proof needs another run. In Scenario evidence, expand Cart quantity updates the total and use Open evidence item. For CI outcomes, on Today open Bundle check failed on the pull request or Optional check still running.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                                 | Exact command                               | Observable result                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----------------------------------------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open proof, enlarge the image and inspect evidence and logs | `node .kipster/verify/drive.mjs proof`      | Verified at aaaaaaa and Ready to merge appear; Escape closes the viewer; evidence survives reload; the cart log loads and video has controls.                                                                                                                                                                                                                                                                       |
| Inspect stale proof while work is queued                    | `node .kipster/verify/drive.mjs stale`      | The verdict says Stale: new commits since verification; the gate explains queued/running build work and keeps Earlier green head aaaaaaa.                                                                                                                                                                                                                                                                           |
| From Today open Bundle check failed on the pull request     | `node .kipster/verify/drive.mjs ci-failed`  | The ticket is queued at Step 1 of 5 (build) with Latest CI failed: Bundle; the gate says Blocked: CI failed and lists Demo repository checks: passed · required and Bundle: failed · not required; opening the maintain-pr finding CI failed: Bundle shows a Bundle link to https://github.com/kipster/demo-shop/actions/runs/440/job/442 and the excerpt dist/assets/index.js is 312.4 kB, over the 250 kB budget. |
| From Today open Optional check still running                | `node .kipster/verify/drive.mjs ci-pending` | maintain-pr shows ready with CI passed.; the gate says Ready to merge and Live CI lists Demo repository checks: passed · required and Bundle: pending · not required.                                                                                                                                                                                                                                               |

## Gotchas

The two CI tickets come from the real check inspection (`inspectChecks`) and maintain-pr result, fed fixture GitHub output while seeding; the server never calls GitHub. Their links are fictional; check the href, do not follow it.

All seeded media, GitHub URLs, commits, verdicts and gate facts are synthetic. Do not follow external PR/commit links or claim they prove a real branch. Scheduler-off gates do not refresh GitHub facts. Running log updates, failed/unobserved verdicts, CI transitions, pruned evidence and real merge/retest flows are unverified here; see tests/e2e/proof.spec.ts, tests/e2e/merge-gate-evidence.spec.ts and the engine integration tests. The supplied instance has no /__test endpoints.
