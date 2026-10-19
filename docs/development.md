# Development

See [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request.

## Run from source

Requires Node.js 26.10 (see `.nvmrc`) and PostgreSQL 18 (`initdb` and `pg_ctl`
on `PATH`).

```sh
nvm install
npm ci
npm run dev        # local database, API on :4600 and the web app on :5173
```

`npm run dev` does not restart the factory on source edits, so active agent steps
keep running. Stop and start it explicitly to load server changes, or opt into
automatic restarts with `npm run dev -- --watch`. Vite still hot-reloads the web app.
Startup also builds the web app for the API origin on :4600, so PR evidence and
ticket links work there; :5173 remains the live development UI.

`npm run dev` keeps its database in `.local/`. To run a source checkout like an
installation, build the web app, set up and serve:

```sh
npm run build
npm run kf -- setup
npm start
```

`kf setup` creates and migrates a private PostgreSQL cluster in the factory home
unless you pass `--database-url <url>` to use your own database. It keeps the
configured port, or picks the first free port from 4600 on first setup. Re-run it to
update settings; other configuration fields are retained. For scripts, use
`npm run kf -- setup --non-interactive`. Use `--home <directory>` on setup and
serve for a separate factory.

Concurrency, the step timeout (120 minutes by default) and the agent for each
role and reviewer lists, globally or per workflow, are edited on the web app's Settings page and
apply to steps that start afterwards, without a restart. `config.json` supplies
their starting values until the first save; see
[the architecture](architecture.md#settings-page).

TypeSafe is optional: its key powers decision steps (for example judging whether
a PR is safe to auto-merge). Without it those decisions come to you. Store a key
with `kf secret set typesafe`, or validate one from stdin during setup with
`--typesafe-stdin`.

Manage secrets with `npm run kf -- secret set <name>`, `secret list`, and
`secret remove <name>`. Set reads hidden terminal input or piped stdin; list
shows names and backends only. Secrets use the OS credential store, with a
mode-0600 `secrets.json` fallback if it is unavailable. No environment variables
or .env files configure integrations. `--secret-backend file` explicitly chooses
the file store for headless installations and tests. Only macOS Keychain has been
tested; Linux Secret Service is supported but unverified, and Windows validation
is deferred. Browsers on other origins may call the API only if they are
listed in `allowedOrigins` (default: the Vite dev server and the Tauri shell).

## Develop

```sh
npm run check      # lint, format and type checks
npm test           # unit and integration tests against a throwaway PostgreSQL
npm run test:e2e   # browser tests against the built app
npm run kf -- check --workflows <dir>   # validate a directory of workflow files
npm run dev -- --no-scheduler # serve UI without running agents
npm run seed:demo  # fill the dev database with tickets in every state
```

Demo seeding requires an empty database with no running scheduler. Stop the
normal dev server, seed, then use `npm run dev -- --no-scheduler` (or
`kf serve --no-scheduler`). A database marked as demo refuses to start a
scheduler, including after a restart. Keep real runs in a separate checkout's
`.local/` database. Development workspaces and evidence also live under
`.local/factory/`. Demo media is generated there (synthetic images/video/logs,
never real verification evidence); seed with `--home <directory>` when serving a
different home. The demo includes valid/invalid kits and current/stale lead
verdicts with recorded commits. Override with `npm run dev -- --home <directory>`.
It also includes **Overnight report export (synthetic demo)**, a lights-out lead
with a Decision log, a parked child with a recorded choice and a merged
child whose checker left an item unverified. **Document the API rate limits
(checked without verify)** and **Show stock levels on product pages (checked
with verify)** are lights-out leads whose task ran build then test and whose
final test ran; the first, in `kipster/docs-site` without a verify block, shows
the unverified item in its task result and merge gate. **Historical quick-change ticket** retains a completed plan from
the retired workflow and waits for plan approval. These are
synthetic choices for UI inspection; no agents or real verification ran.
