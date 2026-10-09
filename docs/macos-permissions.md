# macOS background-service permissions

The Factory is still downloaded and operated with `kf`, with its UI in a browser.
The release includes a small background app with no window, designed to give
the service and its children the macOS identity **Kipster Software Factory**
(`app.kipster.factory`). Verify actual privacy attribution as described below.
It is separate from the Kipster project's backend (`app.kipster.backend`).

## What this fixes

The 0.4.0 service started the bundled Node directly. On the affected Mac Studio,
macOS rejected Apple Events from the Codex computer-use helper because its
responsible process was Node, whose hardened-runtime signature did not include
`com.apple.security.automation.apple-events`. The helper was trying to act on
behalf of the Factory. Updating Codex did not repair that parent identity.

The native launcher now stays the parent, carries that entitlement and a readable
`NSAppleEventsUsageDescription`, and is associated with the login service. Its
bundle identifier, Developer ID signing team and installed path stay consistent
across releases. This follows [Apple's guidance on responsible code and native
main executables](https://developer.apple.com/forums/thread/678819).

Mac app control remains available to every job. This change does not disable
plugins, MCP servers, hooks or any agent tools, and does not reset saved macOS
permissions or modify the user's Codex configuration.

The incident also included a jammed `tccd` with its dispatch-thread limit reached
and file operations blocked. Restarting it restored file access. The available
evidence does **not** establish that the missing entitlement alone caused that
jam or explain every reported Photos prompt. Failed permission checks must not
be counted as displayed dialogs. This patch repairs confirmed packaging defects;
it is not proof that every cause of a privacy-service hang has been eliminated.

## User setup

Install or update normally, then use `kf start`. The first migration from the
Node-based service may require new approvals for the Factory identity. macOS
retains eligible approvals for that identity across restarts and signed updates.
Different resources and target applications may require separate consent.

If macOS denies access, review **System Settings → Privacy & Security** for
**Kipster Software Factory**. Automation, Accessibility, screen recording and
file access are different categories. Give the access your jobs need; an
automation entitlement does not grant these permissions or bypass a denial.

When selecting the background app in System Settings, use Go to Folder and enter
`~/.kipster-factory/service/` (or `<custom home>/service/`). Source development
continues with `npm run dev` or `kf serve`; terminal-run development is not a
test of the installed background service's privacy attribution.

## Building and releasing

`node scripts/native.ts --out .local/native` compiles an ad hoc signed development
launcher. Ad hoc builds exercise process behavior; they do not prove persisted
privacy grants across releases. Public bundles must contain a Developer ID
signed, notarized and stapled launcher. The release workflow enforces this and
the Factory bundle identifier with the expected signing team configured for this
repository. Set the `APPLE_TEAM_ID` variable in the **release** environment to
that team's 10-character ID. Keep the team stable across releases; changing it
may require users to approve permissions again.

Configure these secrets in this repository's GitHub **release** environment:

| Secret                       | Value                                         |
| ---------------------------- | --------------------------------------------- |
| `APPLE_CERTIFICATE`          | Base64 of the Developer ID Application `.p12` |
| `APPLE_CERTIFICATE_PASSWORD` | Password of the `.p12`                        |
| `APPLE_SIGNING_IDENTITY`     | Developer ID Application signing identity     |
| `APPLE_API_PRIVATE_KEY`      | Notarization API `.p8` contents               |
| `APPLE_API_KEY_ID`           | Notarization API key ID                       |
| `APPLE_API_ISSUER`           | Notarization API issuer ID                    |

The Factory uses its own app identity even if the same developer signs both
projects. Missing credentials fail the release instead of publishing an unsigned
background service. PR builds use ad hoc signing and do not access these secrets.
Publishing also requires a new package version; the release workflow does not
replace an existing release such as 0.4.0.

The signing certificate's developer name is public in the distributed signature.
The app's display name does not hide it. Use an organization-issued Developer ID
certificate if a personal name must not be exposed. This does not require end
users to have an Apple Developer account or to sign in to one.

`kf start` validates the app signature and automation entitlement before stopping
an existing service. It copies with `ditto` to retain signing/notarization data.
The launcher remains at a fixed path; its runtime manifest is private and outside
the signed app. Configuration files, database and task state are retained.

## Verification before declaring the incident resolved

Automated tests cover real native process ancestry, exit status, signal forwarding,
stable installation paths, private manifests and a failed stop preserving the old
runtime. Bundle checks exercise the actual packaged Node, PostgreSQL and UI/API.

On a test Mac or disposable macOS VM with the **Developer ID signed release**:

1. Install and start the login service, then run a Factory job using computer
   control. Inspect TCC attribution: the responsible app must be
   `app.kipster.factory`, with no missing automation-entitlement error.
2. Approve the required access, repeat the same operation in fresh jobs, restart
   the service and log in again. The same persistent grant should remain valid.
3. Update to another signed release and repeat the operation. Verify the same
   bundle identifier, signing requirement, installed app path and approvals.
4. Deny a permission in the test account and repeat. Check actual dialogs, the
   agent's failure handling and TCC request rate. Inspect the enabled tools'
   lifecycle hooks, including computer-use cleanup on jobs that never called a
   computer-use tool. Do not infer a prompt loop from error-log counts alone.
5. Run concurrent jobs, check cancellation and shutdown, and monitor `tccd` CPU,
   thread growth and ordinary Documents access. Capture the exact requesting
   process and permission category if requests repeat.

These installed-service consent checks require a logged-in test user and are
separate from the local ad hoc tests. Do not reset a real user's TCC database or
grant broad permissions to make the tests pass.
