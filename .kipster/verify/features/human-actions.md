# Human approvals and asks

## Sub-features

- Plan disclosure, approval, change comments and rejection.
- Ask retry, move to another step, cancel and required notes.
- Grouped attempt history, human decisions and optional internal events.

## How to get to it (user point of view)

On Today open a plan waiting for approval, such as Add CSV export to reports, or an ask such as Validate email addresses on sign-up. Each action command uses its own seeded ticket, titled with its action: Add gift notes to orders (plan to approve), Add a size guide to product pages (plan to change), Add a loyalty points page (plan to reject), Validate postcodes at checkout (ask to retry), Validate phone numbers on the account page (ask to move) and Validate coupon codes in the cart (ask to cancel).

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                       | Exact command                             | Observable result                                                                                              |
| ------------------------------------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Read the ask timeline and reveal internal events  | `node .kipster/verify/drive.mjs timeline` | The quiet timeline initially hides events; keyboard Show all events displays claimed events.                   |
| Approve the plan to approve                       | `node .kipster/verify/drive.mjs approve`  | Acceptance scenarios are visible, and approval changes the ticket to queued.                                   |
| Request a revision of the plan to change          | `node .kipster/verify/drive.mjs changes`  | An empty comment produces an alert; submitting a comment returns the ticket to queued.                         |
| Reject the plan to reject                         | `node .kipster/verify/drive.mjs reject`   | The ticket changes to cancelled.                                                                               |
| Retry the ask to retry with a required note       | `node .kipster/verify/drive.mjs retry`    | A loop reached its limit. is shown; an empty note produces an alert; retry with a note queues the review step. |
| Move the ask to move to the lead step with a note | `node .kipster/verify/drive.mjs move`     | Move ticket queues the lead step.                                                                              |
| Cancel the ask to cancel                          | `node .kipster/verify/drive.mjs cancel`   | The ticket changes to cancelled.                                                                               |

## Gotchas

Every action has its own ticket, so all six run on one instance in any order; timeline reads Validate email addresses on sign-up, which no command changes. Each action can run once per instance because it consumes its ticket's waiting attempt; do not reseed or change database rows to repeat it. Request another factory-owned instance instead. The asks run a historical copy of lead whose review limit asks the owner. Scheduler-off queues do not execute. Additional safe Markdown, timeline and keyboard tests live in tests/e2e/factory.spec.ts.
