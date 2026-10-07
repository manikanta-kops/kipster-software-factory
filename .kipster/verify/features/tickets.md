# Ticket creation and repository context

## Sub-features

- Repository and workflow choice, title, Markdown body and preview.
- Optional registered read-only dependencies and queued detail.
- Linked repository ticket waiting and cancellation semantics (not seeded here).

## How to get to it (user point of view)

Choose New ticket in the header. Select kipster/demo-shop and lead (task and task-pr are only for a lead's tasks). The created ticket opens at #/tickets/<number>.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                                  | Exact command                               | Observable result                                                                                                    |
| ------------------------------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Preview Markdown and create work with a reference dependency | `node .kipster/verify/drive.mjs new-ticket` | Goal preview appears; a unique lights-out lead ticket is queued and Read-only dependencies lists kipster/legacy-api. |
| Read a queued ticket and running/finished work on Today      | `node .kipster/verify/drive.mjs today`      | Seeded work appears in the appropriate attention/progress/finished area.                                             |

## Gotchas

Lead tickets default to lights-out. New tickets stay queued because agents never run here. Dependency checkouts are not fetched by this instance; selection proves stored UI context only. Linked ticket creation, parked status, reverse links and local cancellation require the separate fixtures in tests/e2e/other-repositories.spec.ts; they are unverified on the supplied demo instance. IDs are discovered by title through the supplied API, not hard-coded.
