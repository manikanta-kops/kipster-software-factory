# Web app

React 19 + TypeScript, built by Vite into `dist/web/`. Serve that folder with
any static host. There is no server rendering. Run `npm run build -- --base=./`
when hosting under a subdirectory or packaging relative assets for a desktop
webview. Routes use fragments (`#/tickets/4`), so they do not require HTTP
history APIs or per-route server handling. An index.html fallback is sufficient.

## API connection

All fetch requests and the single EventSource live in `src/api.ts`. The default
API base is the current origin. To build against a separate factory:

```sh
VITE_API_BASE_URL=https://factory.example.com npm run build
```

Set the server origin (optionally with a path prefix), **without** `/api`.
Alternatively, set `window.KIPSTER_API_BASE_URL` before the app's module script
runs, for example from the embedding application's initialization script:

```js
window.KIPSTER_API_BASE_URL = 'http://127.0.0.1:4616'
```

The runtime value takes precedence over the build-time value. The API server
must allow the web app's origin through its existing `allowedOrigins` setting.
A desktop webview also needs its origin allowed and its CSP to permit the API
connection. This UI does not configure a Tauri host or its permissions.

Server state lives in TanStack Query; form drafts live in React memory. Nothing
is stored in localStorage, sessionStorage, IndexedDB, cookies, or service workers.
Appearance follows the operating system's light/dark preference.

EventSource reconnects natively with Last-Event-ID. Ticket events invalidate the
list and affected detail; repository events invalidate repositories. Each ready
message also reconciles cached queries, including the initial fetch/stream race.
The header reports when live updates are reconnecting.

Markdown uses react-markdown and remark-gfm, skips raw HTML, and never injects
HTML. Remote markdown images render their alt text rather than loading resources.
File artifacts are requested only after expansion; logs render as plain text.

## Browser verification

`npm run test:e2e` builds the static app and runs against a throwaway PostgreSQL
cluster. Every test gets an isolated database seeded through `seedDemo`, plus a
plan/log fixture. Fixture endpoints exist only in `tests/e2e/server.ts`.
`appearance.spec.ts` captures every page plus ask/merge ticket states at 390 px
and 1280 px in light and dark themes and checks for horizontal page overflow.
Screenshots are attached to Playwright test results.
