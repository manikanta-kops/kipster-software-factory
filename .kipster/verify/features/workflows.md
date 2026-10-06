# Workflow library and uploads

## Sub-features

- Built-in versioned workflows, roles, needs and route limits.
- Selecting a step and displaying all loops.
- Uploading YAML, validation errors and uploaded versions.

## How to get to it (user point of view)

Choose Workflows in the header, then quick-change in its workflow list. Upload workflow accepts a YAML file.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                      | Exact command                              | Observable result                                                                                    |
| ------------------------------------------------ | ------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Select review and show every loop                | `node .kipster/verify/drive.mjs workflows` | quick-change is visible; review has aria-pressed=true; Show all loops is checked.                    |
| Upload invalid YAML, correct it and upload again | `node .kipster/verify/drive.mjs upload`    | The invalid role shows an alert; the corrected unique workflow shows its saved content-hash version. |

## Gotchas

Uploads mutate only the supplied database and remain until the instance is discarded. The helper uses in-memory YAML, not files from outside the checkout. Uploaded workflow execution is disabled. Built-in name collisions and updates of uploaded names have coverage in tests/e2e/workflow-upload.spec.ts and tests/workflow-upload.test.ts.
