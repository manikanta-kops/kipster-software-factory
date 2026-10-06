# Today and navigation

## Sub-features

- Needs you, Moving and collapsed finished work.
- Repository/workflow filtering, live connection status, hash navigation.
- Phone layouts, OS appearance and keyboard skip link.

## How to get to it (user point of view)

Open the factory URL. Use Today in the header to return home.

## Driving it

Use the APP_URL and EVIDENCE_DIR environment from [the guide](../README.md).
Every command asserts the results and saves a screenshot, trace and JSON observation.

| User action                                       | Exact command                               | Observable result                                                                                     |
| ------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Read attention, progress and expand finished work | `node .kipster/verify/drive.mjs today`      | Needs you and Moving appear, Live is shown, and Show finished reveals the completed dark-mode ticket. |
| Filter for feature work with keyboard dismissal   | `node .kipster/verify/drive.mjs filter`     | The ask ticket disappears; the cart proof stays visible; Escape closes Filters and restores focus.    |
| Inspect phone layouts and use Skip to content     | `node .kipster/verify/drive.mjs responsive` | Pages fit 390 px in light and dark; the skip link focuses main; screenshots are saved for each page.  |

## Gotchas

Run today before any mutations: Show finished (2) describes the initial seed. Filter state lives in the React session. Dates and elapsed times are dynamic. Live means SSE connected, not that the disabled scheduler is executing work. Desktop and ticket-layout coverage is also in tests/e2e/appearance.spec.ts.
