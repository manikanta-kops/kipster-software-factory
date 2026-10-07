# Typed decisions and owner overrides

## Sub-features

- Needs-you choices and recent typed outcomes.
- Counts by workflow step, owner answers and override history.
- Confirm-band accept/override controls and routing (separate fixtures).

## How to get to it (user point of view)

Choose Decisions in the header. Pending choices, when available, link to their ticket; the default demo contains none.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                         | Exact command                              | Observable result                                                                                  |
| --------------------------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Open the decision ledger without an integration key | `node .kipster/verify/drive.mjs decisions` | Decisions loads with No decisions yet. They appear here when a step decides how a ticket moves on. |

## Gotchas

No TypeSafe key or model call is used. The demo has no typed decision fixture, so confirm/override controls and their routing are not proven by this command. tests/e2e/decisions.spec.ts exercises those controls and counts against its independently owned PostgreSQL fixtures without a real key. Do not create an integration secret or enable the scheduler to populate this page.
