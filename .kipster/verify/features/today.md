# Today and navigation

## Sub-features

- Ticket summaries (what needs you, and recent completions), Moving and collapsed finished work.
- Repository/workflow filtering, live connection status, hash navigation.
- Phone layouts, OS appearance and keyboard skip link.

## How to get to it (user point of view)

Open the factory URL. Use Today in the header to return home.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                       | Exact command                               | Observable result                                                                                                                                     |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read attention, progress and expand finished work | `node .kipster/verify/drive.mjs today`      | Ticket summaries lists the ask, Moving lists the queued README ticket, Live is shown, and Show finished (N) reveals the completed dark-mode ticket.   |
| Filter for task-pr work with keyboard dismissal   | `node .kipster/verify/drive.mjs filter`     | Checking Task pr hides the ask; Optional check still running stays; Escape closes Filters and focuses task pr work; Show everything restores the ask. |
| Inspect phone layouts and use Skip to content     | `node .kipster/verify/drive.mjs responsive` | Pages fit 390 px in light and dark; the skip link focuses main; screenshots are saved for each page.                                                  |

## Gotchas

N in Show finished (N) is the number of done and cancelled tickets the API reports when the command starts (5 in a fresh seed), so reject and cancel runs do not break it. A Needs you heading appears only for waiting tickets without a summary; seeded ones all have summaries. Filter state lives in the React session. Dates and elapsed times are dynamic. Live means SSE connected, not that the disabled scheduler is executing work. Desktop and ticket-layout coverage is also in tests/e2e/appearance.spec.ts.
