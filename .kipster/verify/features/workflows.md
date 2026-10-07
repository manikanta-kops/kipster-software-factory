# Workflow library and uploads

## Sub-features

- Built-in versioned workflows, roles, needs and route limits.
- Selecting a step and displaying all loops.
- Uploading YAML, validation errors and uploaded versions.
- Removing an uploaded workflow, with confirmation; refused for workflow files and while unfinished tickets use it.

## How to get to it (user point of view)

Choose Workflows in the header, then quick-change in its workflow list. Upload workflow accepts a YAML file.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                      | Exact command                                  | Observable result                                                                                                                      |
| ------------------------------------------------ | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Select review and show every loop                | `node .kipster/verify/drive.mjs workflows`     | quick-change is visible; review has aria-pressed=true; Show all loops is checked.                                                      |
| Upload invalid YAML, correct it and upload again | `node .kipster/verify/drive.mjs upload`        | The invalid role shows an alert; the corrected unique workflow shows its saved content-hash version.                                   |
| Remove the seeded upload while tickets use it    | `node .kipster/verify/drive.mjs remove-in-use` | lead has no Remove; removing synthetic-review is refused, listing the running ticket, the lead and its running child; it stays listed. |

## Gotchas

Uploads mutate only the supplied database and remain until the instance is discarded. The helper uses in-memory YAML, not files from outside the checkout. Uploaded workflow execution is disabled. Built-in name collisions and updates of uploaded names have coverage in tests/e2e/workflow-upload.spec.ts and tests/workflow-upload.test.ts. The seed uploads synthetic-review and leaves it in use by a running ticket and by a lead whose running child task runs it, so `remove-in-use` only drives the refusal and changes nothing. Successful removal and finished tickets that still open are covered by tests/e2e/workflow-remove.spec.ts and tests/workflow-upload.test.ts; to drive them, upload and remove a new workflow instead. Removing deletes only the upload's library entry, never stored versions or tickets.
