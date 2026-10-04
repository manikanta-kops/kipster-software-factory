# Repository kit (version 1)

A target repository commits `.kipster/` to its default branch. The factory reads
committed blobs after every cache fetch; it never trusts a stale cache checkout.
Repository `kit` is `{ status: "missing" | "valid" | "invalid", error: string | null,
capabilities: string[] }`. Missing/invalid kits provide no capabilities. Invalid
kits report the validation error. A valid kit provides `setup` when declared and
`verify` when its verify block and required verification documents are valid.
The existing repository `capabilities` field is an alias. A pending repository
has a missing kit until its first fetch. Ticket-branch kits do not grant default
branch capabilities before merge and a subsequent fetch. Owner-merge detection
fetches again so a merged onboarding kit becomes available immediately.

```yaml
version: 1
setup: npm ci
check: npm run check && npm test
verify:
  start: node app.js --port {port} --database-url {databaseUrl}
  ready: http://127.0.0.1:{port}/health
  ports: 1
  database: postgres
  timeoutSeconds: 60
```

`version` and nonempty `check` are required. `setup` and `verify` are optional;
omitting verify describes a repository that cannot yet run tester workflows.
Unknown keys are rejected by Zod. All commands run with `/bin/sh -c` at the fresh
checkout root. Setup installs dependencies in every fresh checkout. Check is the
repository's deterministic gate. Neither command may launch persistent services.
They run before instance ports and a database are provisioned; a check that needs
its own test database must manage that independently of the instance database.

Verify requires every illustrated key. `ports` is an integer from 1 to 16;
`database` is `postgres` or `none`; timeout is positive, at most 3600 seconds.
Start and ready must contain `{port}`. Extra ports use `{port2}`, `{port3}`, etc.;
`{port1}` aliases `{port}`. Postgres start must contain `{databaseUrl}`. Placeholders
in commands are shell-quoted by the factory: **do not quote them yourself**. With
`none`, databaseUrl is null in the returned handle and expands to an empty string.
Ready is a local HTTP URL (127.0.0.1, localhost or [::1]) whose port is `{port}`. It is polled for 2xx;
redirects do not count. Bind the app to the allocated ports, never a fixed port.
Timeout measures start/readiness; the engine's step deadline covers setup/check
and preparation as well. Start must stay in the foreground. It initializes the
empty database, applies app migrations and seeds any deterministic test users.
Do not use the factory's own database or any shared development database.

## Files

- `roles/<role>.md`: optional repository instructions, appended to the fixed role
  prompt as before.
- `verify/README.md`: required, nonempty when verify exists. Explain the provided
  URL, test users, app-driving tools/commands, evidence capture, state reset and
  how to navigate the feature maps. Agents use the instance the factory supplies;
  they never launch or stop it. Screenshots, recordings and logs go to evidenceDir.
- `verify/features/<feature>.md`: at least one map when verify exists. Each map
  has exactly these four nonempty level-two sections, in this order. A title is
  optional. Driving steps use a three-column table with the exact headings below.
  Avoid literal table pipes within cells (use `&#124;`).

```markdown
# Cart

## Sub-features

- Quantity changes and running totals.

## How to get to it (user point of view)

Open the shop and select Cart in the header.

## Driving it

| User action      | Exact command                                 | Observable result                    |
| ---------------- | --------------------------------------------- | ------------------------------------ |
| Open Cart        | `browser open "$APP_URL/cart"`                | Cart heading and seeded item appear. |
| Capture the cart | `browser screenshot "$EVIDENCE_DIR/cart.png"` | Image shows item quantity and total. |

## Gotchas

Use the test user described in verify/README.md. Reset the cart before each case.
```

The example browser commands are illustrative: the onboarder must substitute the
actual installed tool's runnable commands, selectors and assertions. The validator
checks structure, required sections and paired rows; it cannot prove a command's
meaning. The onboarder records how each map was checked. The independent tester
will drive it. **A generated kit that never ran is a draft.**

## Factory service contract

`startVerification(options)` from `src/verification/harness.ts` accepts:

- `home`: factory home; `repository`: local cache or ticket repository containing
  the objects; `commit`: full 40- or 64-character Git object ID.
- `kit`: parsed `Kit` from `src/kit/kit.ts` (`loadKit(path, commit, signal?)` reads
  and validates a committed kit; `parseKit(yaml)` validates the YAML alone).
- `database`: factory pool opened with `openDatabase`; `signal?`: caller lifetime.
- `check?`: default false; true runs check immediately after setup.

It returns `{ url, ports, databaseUrl, checkout, evidenceDir, logs, exited, stop }`.
URL is the expanded readiness URL (use `new URL(url).origin` for app navigation).
Ports is an ordered number array. Database URL is null for none. Checkout is a
separate detached clone at exactly the requested commit, under factory home;
its object store borrows the cache read-only. Setup may generate or modify files
there; it cannot dirty the ticket checkout. The start process is supervised in its
own POSIX process group. `exited` rejects on unexpected exit, including after
readiness. Callers must await `stop()` in `finally`; it is idempotent and kills
only that process group, drops only its generated `verify_<uuid>` database, and
removes only its disposable checkout. Evidence remains under
`home/verification/evidence-<unique>/`. Caller cancellation also stops a returned
instance. Factory-crash supervision terminates processes; database/checkout
recovery after SIGKILL is not implemented in this slice.

Ports are reserved until start and tracked across live handles. Binding by an
external process in the handoff window can still make start fail; no fixed-port
fallback is used. The PostgreSQL role needs CREATEDB and ownership of the generated
databases. Cleanup uses DROP DATABASE WITH (FORCE) for those databases only.

Logs are artifact inputs `{ kind: 'log', title, path }`: setup.log and start.log,
plus check.log when requested. `VerificationError` exposes `stage`, `logs` and
`evidenceDir`; stages are kit, checkout, setup, check, ports, database, start,
ready and stop. Partial resources are cleaned before a start failure returns.
`verificationFinding(error)` gives a finding with the stage and bounded log tails.

`verify-kit` is a system action with no parameters, success `passed`, outcomes
`passed` and `failed`. It validates the ticket HEAD's kit, runs setup → check →
start → ready → stop and attaches logs on either outcome plus a finding on failure.
The onboard workflow routes failed back to write-kit, with limit 3 (then asks a
human), and only a passed run proceeds to approve-kit. It proves the kit can boot;
it does not claim to have driven every feature.

## Shared evidence and commit contract

`Artifact.mediaType` is a MIME type without charset parameters. File signatures
identify PNG/JPEG/GIF/WebP/WebM/MP4; UTF-8 text uses its Markdown/JSON extension or
text/plain, other bytes application/octet-stream. HTML is inert text. Inline
content is text/markdown. Agents do not choose the type. The artifact endpoint
serves the detected type with nosniff and a sandbox CSP; existing path containment
and symlink checks remain. Old files receive the generic type until resolved by
the API. Evidence files must stay under factory home, and are copied into step
storage when an agent result is ingested.

`Attempt.headCommit` is a nullable full object ID observed by the factory at
completion. Agent steps and verify-kit/maintain-pr/merge record it; execution failures also retain
an observation if their checkout is readable. Null
means no commit observation (legacy records, human decisions or attempts that
failed before the branch could be read). It is separate from the agent result;
agents cannot self-report it. Compare a verdict's commit to the latest observed
branch commit; never treat null as current. A later differing attempt commit is
sufficient to display a stale verdict. Live branch/base movement detection and
retest routing belong to ready-to-merge (Slice 3); this foundation does not assert
that a stored latest commit is a live Git ref.

Tester (2B) should load the trusted default-branch kit, call the harness for the
exact ticket commit, supply URL/checkouts/evidenceDir to its fresh tester session,
race execution against `exited`, retain evidence, discard tester edits and await
stop in finally. Web (2C) consumes kit, mediaType and headCommit from the existing
endpoints and uses the artifact endpoint for media. Ready-to-merge (3) must compare
live HEAD/base with verdict commits before treating evidence as current, and
retest after synchronization. No workflow step fields or result.json fields were
added by this foundation.
