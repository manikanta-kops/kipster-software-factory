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
Image evidence appears as inline thumbnails with a modal viewer (Escape closes and
returns focus). Videos use native controls without autoplay. Media URLs respect
the configured API base. Text files load only after expansion; logs render as
scrollable, keyboard-focusable plain text. Other files have an explicit open link.

The latest completed tester verdict is shown near the ticket header. Later
recorded attempt commits that differ from its commit mark it stale; this is not a
live Git ref check. Missing commits are explicitly unverified. Commit links use
the repository clone URL to identify GitHub, rather than assuming every slug is
hosted there. Repository kits show status, capabilities and validation errors;
gated workflows offer one-click onboarding when the repository is ready.

`#/settings` edits the engine settings through `GET`/`POST /api/settings`. The
form validates with the same schema as the server (`src/domain/settings.ts`)
before sending, shows each problem next to its field, and shows the server's
issues when it rejects a save. Attempts show the agent CLI, model and effort
they ran with. Global and workflow reviewer lists have add/remove controls;
workflow lists can inherit the global list. Same-family reviewer choices warn
without blocking a save. Independence replacements and exceptions appear as
notes in the ticket timeline.

## Browser verification

`npm run test:e2e` builds the static app and runs against a throwaway PostgreSQL
cluster. Every test gets an isolated database seeded through `seedDemo`, plus a
plan/log fixture. Fixture endpoints exist only in `tests/e2e/server.ts`.
`appearance.spec.ts` captures every page plus ask/merge ticket states at 390 px
and 1280 px in light and dark themes and checks for horizontal page overflow.
Screenshots are attached to Playwright test results.

A ticket whose latest tester reported unverified items shows each as an
**Unverified by** badge near its status. Scenario evidence counts them as
unverified, separately from passed and failed scenarios. Tickets whose tester was skipped before
every task was checked still show **Untested** with the missing capability and
skipped step.

Uploaded workflows show Remove on the Workflows page. It asks for confirmation,
then calls `DELETE /api/workflows/:name`; a refusal shows the server's message
with the unfinished ticket numbers. Workflow files show no Remove. A link to a
workflow that is no longer in the library says so and shows the first workflow.

New ticket offers `bug`, `lead`, `onboard-repo` and uploaded workflows; child
workflows stay hidden. The Lights-out checkbox defaults on for `lead` and
`program-lead`, follows workflow changes until touched, and is saved with the
ticket. Enabled tickets show a Lights-out badge. Their Decision log shows
typed choices, alternatives and reasons, with links to child decision logs.
A child awaiting a decision stays unfinished as a parked task while siblings
continue. Lights-out leaves the merge gate and untested warnings in effect.

Ticket pages show a compact fact-based summary for parked and finished tickets:
Ready, Needs you with an action count, or Blocked; linked actions, activity and
only present issues/unverified facts. View details scrolls and moves keyboard
focus to the rest of the ticket. Today gives one row to each owner ticket
(leads, bugs, onboarding); a lead's sub-tasks fold under its row, in Needs you
and in Moving. Needs-you cards and factory-merge rows carry the summary pill and
its one-line activity; queued and running rows keep their live line. A lead
with a waiting sub-task needs you, counted on its pill. Finished tickets whose
summary still needs you stay in Needs you for 24 hours; the rest fold into
Finished. A sub-task the lead retried under the next key (`export` →
`export-2`) reads "Replaced by #N" in the fold, the lead's task list and its own
ticket, never Blocked. Older tickets with no stored summary retain their
existing view. Resumed tickets hide their last parked report. Summary events refresh both
views. The appearance suite covers these reports at 390px and 1280px in both
themes, including the details control.

Today's compact Lessons group lists proposed repository and engine mistakes
with Accept and Reject controls. Repository filters narrow repository lessons;
engine lessons remain visible and workflow filters do not filter lessons.
Repositories has an Accepted lessons section with a required reason for retiring.
No new routes are added. `lesson.*` events refresh both lists, including changes
from another browser. Suggestions are independent of ticket decisions.
