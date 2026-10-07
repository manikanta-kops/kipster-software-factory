# Driving the supplied factory

The factory provides the verification handle: URL, checkout, ports, databaseUrl,
evidenceDir and logs. Its URL ends in `/api/health`; navigate at its origin,
not at the health path. This is a disposable exact-commit copy of Kipster, not
the scratch factory executing your ticket or the owner's installed app.
Only the factory starts and stops it. Never run the kit's start command, your
own harness, `npm run dev`, `npm start`, `kf setup/start/stop/serve`, demo seeding
or the browser test suite from a tester/reproducer session.

## Isolation and seed

Setup runs `npm ci` and builds `dist/web` with an empty `VITE_API_BASE_URL`, so
browser API calls stay on the supplied origin. Use Node 26.10 and PostgreSQL 18
on PATH. Check runs lint, formatting, type checks, real-PostgreSQL tests and
the browser suite with an independently allocated `KSF_E2E_PORT` (see
[isolation](../context/isolation.md)). Checks manage their own test clusters
before the verification database is allocated.

Verify uses the harness's dedicated empty `verify_<uuid>` database, passed
explicitly to both seeder and server. It shares no application tables with the
scratch factory. The shell expands `"$PWD/.local/verification-home"` to an
absolute path inside the disposable checkout for both seeder and server. An
absolute home is required so artifact retention can resolve seeded media paths
without duplicating the home prefix. It contains only this instance's synthetic
media/state. `serve` receives
explicit home, allocated port, database URL, `--no-scheduler` and
`--secret-backend file`. No config, default home, Keychain, GitHub CLI state or
TypeSafe key is needed. The seeder applies migrations and marks the database
as demo; demo databases also reject scheduler startup. Startup never runs setup.

There is no sign-in or test-user account in this app. Use the seeded local
owner UI directly. Repository slugs and PR/commit links are fictional fixtures.
The seed includes demo-shop (valid kit), docs-site (valid kit without verify),
invalid-kit, website (pending) and legacy-api (failed), with tickets covering approval, asks, queued/running work,
finished work, current/stale proof and owner merge waits. It also uploads
synthetic-review, which a running ticket and a lead's running child task use.
Discover ticket IDs through the supplied API or the UI; do not assume numbers. Seeder output is in
the factory's start log. Media and recorded verdicts are explicitly synthetic.

## Runnable browser commands

Use the already installed `@playwright/test` and Chromium. Do not download
another browser or connect to another server. From the supplied checkout:

```sh
cd "$VERIFY_CHECKOUT"
export APP_URL="$SUPPLIED_URL"
export EVIDENCE_DIR="$SUPPLIED_EVIDENCE_DIR"
node .kipster/verify/drive.mjs today
```

`VERIFY_CHECKOUT`, `SUPPLIED_URL` and `SUPPLIED_EVIDENCE_DIR` above mean the
actual values in your instance packet; set them from that packet. The driver
derives the origin even if APP_URL contains the readiness path, checks health,
uses exact accessible names/CSS selectors from the existing browser tests,
and refuses browser requests to other origins. It starts only a browser,
never a factory or database. The feature maps give each supported command and
its expected observable result. Successful assertions print `<scenario>: passed`.
An assertion failure exits nonzero; do not convert it to a passing claim.

Each command uses a fresh browser context and records `<scenario>-passed.png`
or `<scenario>-failed.png`, `<scenario>-trace.zip` and `<scenario>.json` into
EVIDENCE_DIR. JSON includes the actual origin, final route, status and browser
observations; it does not establish the tested commit. The factory pins that
commit. Repeated scenario names overwrite their files: copy evidence to distinct
subdirectories before another run if both results are needed. Bootstrap errors
(missing browser, unreachable health/API) can precede capture; retain their
terminal output as a log. Traces can be inspected with
`npx --no-install playwright show-trace "$EVIDENCE_DIR/today-trace.zip"`.
This opens a trace viewer, not an application instance.

For exploratory driving, use Playwright from this checkout against the same
supplied origin. Preserve screenshots, recordings, request/console logs and
traces only under evidenceDir. Label each proof with its scenario/result and
report the runner's tested commit. Do not commit generated media, runtime
homes, database URLs or local paths. For bug comparisons, use the separate base
and head URLs/evidence directories the factory gives you and capture both.

## Feature maps and order

- [Today and navigation](features/today.md): attention, filters, live status, keyboard and phone appearance.
- [Repositories](features/repositories.md): states, kits, registration, policy and onboarding shortcut.
- [Workflows](features/workflows.md): diagrams, loops and upload validation.
- [Tickets](features/tickets.md): Markdown creation and read-only dependency context.
- [Human actions](features/human-actions.md): approval/revision/rejection, asks and timeline.
- [Proof and readiness](features/proof.md): verdict commits, stale proof, gate and evidence viewers.
- [Decisions](features/decisions.md): integration-free ledger and the limits of its empty seed.
- [CLI](features/cli.md): safe help, version and workflow validation commands.

Run read-only cases first: today, filter, repositories, workflows, timeline,
proof, stale, decisions and responsive. Then run register, policy, upload,
new-ticket and gate-workflows. Policy restores its checkbox to off. Choose one
plan mutation (approve, changes or reject) and one ask mutation (retry, move or
cancel) per fresh instance. Run the CLI map from the checkout terminal.

## Reset and limits

A fresh browser context resets navigation/filter/form state, not database state.
The supplied instance has no reset or `/__test` endpoints. Do not reseed, directly
edit its database, delete its home, or restart it. Request a new factory-owned
attempt/instance for consumed plan/ask alternatives. Registration and uploads
use unique names, and new tickets remain queued with no execution. Adding demo
records does not clone remotes or publish work with the scheduler disabled.

Independent proof concerns the user surface of this supplied app. Real agent
execution, GitHub fetch/push/PR/merge, CI polling, linked-ticket wakeups, TypeSafe
calls, install/update/launchd and OS credential stores are not driven here.
Typed confirmation, linked-ticket views, running log progression, prune states
and live gate transitions use extra fixtures in `tests/e2e/`; those fixture-only
endpoints are not served by this kit. Each map's Gotchas identifies that gap.
Use the deterministic suite as separate evidence and report any missing feature
proof as unverified. A verify-kit pass proves setup/check/start/readiness/stop,
not every map. Until that system action has run, this committed kit is a draft.
