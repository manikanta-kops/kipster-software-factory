# Source CLI and workflow validation

## Sub-features

- CLI help/version and workflow-directory validation.
- Setup, background service management, migrations and integration secrets.

## How to get to it (user point of view)

Use the source checkout terminal and `npm run kf -- <command>` as documented in
README.md. For verification, run only the read-only commands below in the supplied
checkout after setting EVIDENCE_DIR from the guide.

## Driving it

| User action                      | Exact command                                                         | Observable result                                                                    |
| -------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Read CLI help                    | `node src/cli.ts --help > "$EVIDENCE_DIR/cli-help.txt"`               | Help lists commands and explicit home, database, port and scheduler options; exit 0. |
| Read factory version             | `node src/cli.ts --version > "$EVIDENCE_DIR/cli-version.txt"`         | The package version is printed; exit 0.                                              |
| Validate built-in workflow files | `node src/cli.ts check workflows > "$EVIDENCE_DIR/cli-workflows.txt"` | The current built-in workflow count is printed as valid; exit 0.                     |

## Gotchas

These commands do not read config, secrets or start processes. Do not use setup,
serve, start, stop, update, seed:demo, dev, migrate or secret commands from a
proof session. The factory owns the supplied instance. Installation, launchd,
Keychain and real integrations require separate owner-operated validation and
are not proven here. Existing tests/install.test.ts and tests/setup-secrets.test.ts
cover controlled installation/setup boundaries. Do not target the owner's home
or the running scratch factory.
