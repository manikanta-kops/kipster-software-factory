<p align="center">
  <strong>Kipster Software Factory</strong><br />
  Turns tickets into pull requests you can trust.
</p>

You describe a problem and agree the outcome. The factory plans, builds, proves
the change by running the real app, keeps the pull request ready, and only
interrupts you for decisions that are yours to make.

> **Status: Slices 1–3 complete.** Onboard a repository, approve a ticket, and
> let fresh agents build, prove and review it. The factory attaches real browser
> evidence to the tested commit, synchronizes base changes, waits for required
> CI, and routes PR feedback back to the builder. Proven with real agents on the
> private factory-floor test bed; the owner merges. Decisions and merge policy
> come next in the [roadmap](docs/roadmap.md).

## How it works

A **ticket** belongs to one repository and runs one **workflow**. A workflow is
a list of steps of three kinds:

| Kind   | What happens                                                          |
| ------ | --------------------------------------------------------------------- |
| agent  | A fresh agent session in a fixed **role** (planner, builder, tester…) |
| human  | The ticket waits for you to approve, request changes or reject        |
| system | Deterministic work: keep the PR current, merge, decide                |

Each step reports an outcome, and **routes** send the ticket forward, back to
an earlier step, or to you. Loops have limits, so nothing spins forever.

```yaml
name: bug
description: Reproduce the bug first, fix it, prove the fix and land it.
steps:
  - id: reproduce
    kind: agent
    role: reproducer
    needs: [verify]
  - id: fix
    kind: agent
    role: builder
  - id: test
    kind: agent
    role: tester
    needs: [verify]
    limit: 3
    routes:
      changes-needed: fix
  - id: merge
    kind: system
    action: merge
```

Each repository describes how to build, run and verify itself in a `.kipster/`
folder, so the engine stays the same for every project.

- [Architecture](docs/architecture.md): concepts, modules and data flow
- [Workflow format](docs/workflows.md): every field, outcome and default
- [Workflow guide](docs/workflow-guide.md): principles for workflows you can trust

## Run it

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

`npm run dev` keeps its database in `.local/`. To run against your own
database, build the web app and serve:

```sh
npm run build
npm run kf -- setup
npm start
```

`kf setup` asks for the database URL and port, tests the connection, applies
migrations, and checks Git, GitHub authentication, Codex and Claude. Re-run it to
update settings; other configuration fields are retained. TypeSafe is optional:
its key powers decision steps (for example judging whether a PR is safe to
auto-merge). Skip it and those decisions come to you.

For scripts, use `npm run kf -- setup --non-interactive --database-url <url>
--port 4600 --skip-typesafe`. Use `--home <directory>` on setup and serve for a
separate factory. Add `--typesafe-stdin` to validate a key supplied through stdin.

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
npm run kf -- check [dir]   # validate a directory of workflow files
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
different home. The demo includes valid/invalid kits and current/stale feature
verdicts with recorded commits. Override with `npm run dev -- --home <directory>`.

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [Apache-2.0](LICENSE).
