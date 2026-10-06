# Proof, merge readiness and evidence

## Sub-features

- Latest tester verdict with commit link and stale-state display.
- Merge gate, earlier green head and owner rules.
- Scenario index, stable evidence route, image viewer, video and lazy logs.
- Running logs, failure findings, pruned rows and live CI transitions (separate fixtures).

## How to get to it (user point of view)

On Today open Cart quantity changes are proven or Cart proof needs another run. Use Open evidence item in Scenario evidence.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                                 | Exact command                          | Observable result                                                                                                                             |
| ----------------------------------------------------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Open proof, enlarge the image and inspect evidence and logs | `node .kipster/verify/drive.mjs proof` | Verified at aaaaaaa and Ready to merge appear; Escape closes the viewer; evidence survives reload; the cart log loads and video has controls. |
| Inspect stale proof while work is queued                    | `node .kipster/verify/drive.mjs stale` | The verdict says Stale: new commits since verification; the gate explains queued/running build work and keeps Earlier green head aaaaaaa.     |

## Gotchas

All seeded media, GitHub URLs, commits, verdicts and gate facts are synthetic. Do not follow external PR/commit links or claim they prove a real branch. Scheduler-off gates do not refresh GitHub facts. Running log updates, failed/unobserved verdicts, CI transitions, pruned evidence and real merge/retest flows are unverified here; see tests/e2e/proof.spec.ts, tests/e2e/merge-gate-evidence.spec.ts and the engine integration tests. The supplied instance has no /__test endpoints.
