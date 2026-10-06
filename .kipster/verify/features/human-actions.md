# Human approvals and asks

## Sub-features

- Plan disclosure, approval, change comments and rejection.
- Ask retry, move to another step, cancel and required notes.
- Grouped attempt history, human decisions and optional internal events.

## How to get to it (user point of view)

On Today open Add CSV export to reports for a plan, or Validate email addresses on sign-up for an ask.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                      | Exact command                             | Observable result                                                                            |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| Read the ask timeline and reveal internal events | `node .kipster/verify/drive.mjs timeline` | The quiet timeline initially hides events; keyboard Show all events displays claimed events. |
| Approve the seeded plan                          | `node .kipster/verify/drive.mjs approve`  | Acceptance scenarios are visible, and approval changes the ticket to queued.                 |
| Request a revision with a required comment       | `node .kipster/verify/drive.mjs changes`  | An empty comment produces an alert; submitting a comment returns the ticket to queued.       |
| Reject the seeded plan                           | `node .kipster/verify/drive.mjs reject`   | The ticket changes to cancelled.                                                             |
| Retry the ask with a required note               | `node .kipster/verify/drive.mjs retry`    | An empty note produces an alert; retry with a note queues the review step.                   |
| Move the ask to build with a note                | `node .kipster/verify/drive.mjs move`     | Move ticket queues the build step.                                                           |
| Cancel the ask                                   | `node .kipster/verify/drive.mjs cancel`   | The ticket changes to cancelled.                                                             |

## Gotchas

Run timeline before ask mutations. Choose exactly one of approve/changes/reject and one of retry/move/cancel per fresh supplied instance. The alternatives consume the same seeded waiting attempts; do not reseed or change database rows to reset them. Request another factory-owned instance/attempt for alternatives. Scheduler-off queues do not execute. Additional safe Markdown, timeline and keyboard tests live in tests/e2e/factory.spec.ts.
