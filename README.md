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

## Install

On macOS (Apple Silicon or Intel):

```sh
curl -fsSL https://github.com/manikanta-kops/kipster-software-factory/releases/latest/download/install.sh | sh
```

The installer downloads the release for your Mac, checks its SHA-256 against the
release checksums and installs it in `~/.kipster-factory`. The release includes
Node.js and PostgreSQL. It links `kf` into `~/.local/bin` and runs `kf setup --start`, which:

- checks git, the GitHub CLI (showing the signed-in account and its scopes;
  offers `gh auth login` if you are signed out), Codex and Claude Code. The
  factory clones and pushes GitHub repositories with that `gh` login, so no
  separate git sign-in is needed, and your git configuration is not changed;
- asks which agent runs steps by default, only when both are installed;
- creates a private PostgreSQL database in `~/.kipster-factory/postgres` that
  accepts only local socket connections;
- starts the factory in the background, now and at login, and opens it.

The built-in workflows (`bug`, `lead` and `onboard-repo`) are ready immediately.
`lead` covers planned features and small changes; its `task` and `task-pr`
workflows are reserved for child tasks and hidden from New ticket. Re-run the
command, or `kf update`, to update; your
configuration, secrets and database are kept. `kf status`, `kf logs -f`,
`kf stop` and `kf start` manage the background factory.

New `lead` and `program-lead` tickets default to Lights-out: the system approves
lead plans, agents choose and record sensible defaults, and a child needing a
decision parks while siblings continue. New ticket lets you change the setting;
children inherit it, and ticket pages show the Decision log. The merge gate
still applies. Every task and the lead's final change are checked by a tester,
in the running app when the kit can start it and otherwise in a disposable
checkout. What the tester could not prove shows as an **Untested** warning and
requires owner merging. Settings can select
parallel lead reviewers from claude and codex. Lead review has five rounds by
default, then publishes unresolved findings for the owner. The engine replaces
reviewers and testers whose CLI/model matches a builder when an independent
candidate exists; otherwise it records the exception and requires owner merging.

The factory suggests one-line lessons from repeated review findings, recorded
failures and owner corrections when a ticket finishes or needs you. Accept or
reject them in Today's Lessons group; accepted repository and engine lessons
are available to every fresh agent step through a file outside the repository.
Lessons never hold up tickets. Repositories lists accepted lessons with a
Retire control and reason. A repository can have 30 accepted lessons; retire
one before accepting another.

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
[the architecture](docs/architecture.md#settings-page).

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

See [CONTRIBUTING.md](CONTRIBUTING.md). Licensed under [Apache-2.0](LICENSE).
