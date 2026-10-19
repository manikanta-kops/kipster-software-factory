# Install and run

The [setup guide](https://kipster.app/factory/setup) lets your coding agent do
all of this for you. This page describes what it runs, for people who want to
install by hand or understand the background service.

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

The built-in workflows (`bug`, `explore`, `lead`, `onboard-repo` and
`research`) are ready immediately. `lead` covers planned features and small
changes; `explore` makes designs, prototypes or research you open in the
browser, with or without a repository; `research` lets a lead split a question
into validated research tasks and write one report. The `task`, `task-pr` and
`research-task` workflows are reserved for child tasks and hidden from New
ticket. Re-run the
command, or `kf update`, to update; your
configuration, secrets and database are kept. `kf status`, `kf logs -f`,
`kf stop` and `kf start` manage the background factory.

On macOS the background service uses its own signed identity, **Kipster Software
Factory**, for privacy permissions. Mac app control remains available to all
agent jobs. macOS still asks you to approve the access a job needs; the factory
cannot grant it itself. See [macOS permissions](macos-permissions.md) for
setup, release signing and verification.

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
