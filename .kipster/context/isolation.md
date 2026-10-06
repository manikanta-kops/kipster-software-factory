# The factory verifies itself

Use Node 26.10 (`.nvmrc`), npm's lockfile and PostgreSQL 18 tools (`initdb`,
`pg_ctl`). The shell PATH can have another Node or no PostgreSQL; confirm
`node --version` and `initdb --version` first. If either is missing or wrong, switch
with a version manager or put the factory's own Node and PostgreSQL directories,
named in your instructions, on PATH.

Ticket code changes only this checkout. The scratch factory executing the ticket
keeps running its already loaded code. Updating that process requires a deliberate
restart outside agent attempts. Never restart it, the other chat's scratch factory
or the owner's installed app from this task.

Only `verify-kit` and the independent proof runner own verification instances.
This kit uses `database: postgres`: the harness creates a fresh `verify_<uuid>`
database and passes its URL. The start command passes that URL to both the demo
seeder and `kf serve`; neither reads a factory config or chooses a default
database. This intentionally uses the contract's dedicated database option rather
than creating a second managed cluster. It does not read or write the scratch
factory's application tables. Provisioning and dropping that dedicated database
are the harness's responsibility.

The start command passes `"$PWD/.local/verification-home"` as an absolute home
inside the harness's disposable exact-commit checkout, never the ticket worktree's
home. Both seeder and server receive the same path. Demo media paths include the
home; artifact retention resolves relative paths against that home, so a relative
home would duplicate the prefix and fail with `Cannot retain artifact: missing`.
The existing seeder applies migrations, writes synthetic media there and marks the database
as demo. The server also migrates idempotently, binds loopback at the allocated
port, serves `dist/web` and explicitly disables the scheduler. The demo marker
also refuses scheduler startup. `--secret-backend file` is explicit; there are
no seeded secrets, TypeSafe key or agent sessions. No `kf setup` runs, so startup
does not probe the owner's agent/GitHub configuration or Keychain. Normal harness
stop closes the server, drops its database and removes its checkout and home.
Crash recovery after SIGKILL remains a harness limitation described in the kit
contract.

The deterministic gate is the kit's `check`, including an explicit hidden-kit
format check and lint of its JavaScript helpers. `npm test` starts and removes
its own socket-only throwaway PostgreSQL cluster through
`scripts/with-test-database.ts`; browser tests independently do the same through
`playwright.config.ts`. `.kipster/verify/e2e.mjs` allocates a free loopback port,
sets `KSF_E2E_PORT` and invokes `npm run test:e2e`. It refuses server reuse through
the existing Playwright configuration. The release-to-bind race can still fail;
report that failure and rerun allocation rather than borrowing another server.
These tests are deterministic checks, not launches of a verification instance.

Before committing kit edits, format hidden files explicitly with
`npx --no-install prettier --write .kipster`, then execute the complete kit check.
Keep runtime output, screenshots, logs and result.json out of Git. Evidence for
agent attempts belongs under the supplied factory home/evidence directory.
Kit and CI edits are allowed when the ticket needs them; the owner reviews them on
the pull request. Only system actions publish branches, create/update PRs or merge.
