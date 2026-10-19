# Set up the Kipster Software Factory

You are a coding agent setting up the Kipster Software Factory on this person's
computer. Follow the steps in order and run the commands yourself. Stop and ask
the person only where a step tells you to.

The factory runs on macOS only for now.

## 1. Check the computer

| Check        | Command                                 | When it fails                                                                                                                                                                           |
| ------------ | --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS        | `uname -s` prints `Darwin`              | Stop. Tell the person the factory runs on macOS only for now, and that they can ask for their system at https://github.com/manikanta-kops/kipster-software-factory/issues.              |
| Processor    | `uname -m` prints `arm64` or `x86_64`   | Stop. Tell the person the factory supports Apple Silicon and Intel Macs only.                                                                                                           |
| git          | `git --version`                         | Run `xcode-select --install`. Ask the person to finish the dialog that opens, then check again.                                                                                         |
| GitHub CLI   | `gh --version`                          | Run `brew install gh`. Without Homebrew, ask the person to install it from https://cli.github.com.                                                                                      |
| Coding agent | `codex --version` or `claude --version` | At least one must work. Otherwise ask the person which they want: Codex (https://github.com/openai/codex) or Claude Code (https://code.claude.com/docs/en/setup). Help them install it. |

The factory's agents run that CLI with the person's own sign-in. If it has never
been used on this Mac, ask the person to start it once and sign in.

## 2. Check GitHub sign-in

Run `gh auth status`.

- **Signed out:** ask the person to run `gh auth login` in their own terminal.
  It opens a browser. Wait until they confirm, then run `gh auth status` again.
  Never run it for them, and never ask for a token.
- **Missing the `repo` or `workflow` scope:** ask the person to run
  `gh auth refresh -s repo,workflow`.

The factory clones and pushes with this login. It never changes git
configuration.

## 3. Update an existing install

Run:

```sh
test -x ~/.kipster-factory/current/bin/kf && ~/.kipster-factory/current/bin/kf --version
```

If it prints a version, the factory is already installed. Do not reinstall.
Run:

```sh
~/.kipster-factory/current/bin/kf update
```

Configuration, secrets and the database are kept. If steps are running, the
update waits for them and prints its progress. Then go to step 6.

## 4. Install

Download the installer and its checksums from the latest release, verify the
installer, then run it:

```sh
work=$(mktemp -d) && cd "$work"
base=https://github.com/manikanta-kops/kipster-software-factory/releases/latest/download
curl -fsSLO "$base/install.sh" && curl -fsSLO "$base/SHA256SUMS"
grep ' install.sh$' SHA256SUMS | shasum -a 256 -c - && sh install.sh
```

- If the checksum check fails, run nothing. Report it to the person.
- Never run an installer from anywhere other than the release. Never use `sudo`.
- The installer checks its download against the same checksums. It installs into
  `~/.kipster-factory` and links `kf` into `~/.local/bin`. Then it configures
  and starts the factory as a background service that also starts at login.
- Without a terminal, setup asks no questions and keeps the defaults.

## 5. Default agent

When only one of Codex and Claude Code is installed, the factory uses it.

When both are installed, setup cannot ask, so the factory uses Codex. Ask the
person which they prefer. For Claude Code, they change **Settings → Agents →
Default** to `claude` in the factory and save.

## 6. Confirm it runs

```sh
~/.kipster-factory/current/bin/kf status
```

`Service` must say `running at http://localhost:<port>`. Open that address:

```sh
open http://localhost:<port>
```

Tell the person:

- The factory is running at that address. It starts again at login.
- First, onboard a repository. In **Repositories**, add one as `owner/name`.
  Then open **New ticket**, choose it, and start the onboarding ticket. An agent
  writes the repository's `.kipster/` kit and proves it works. The person reviews
  and merges that pull request, and then the repository is ready for tickets.
- Open a new terminal to use `kf` by name.

## macOS privacy prompts

When agents work, macOS may ask to allow **Kipster Software Factory** to reach
files, other apps or the screen. Only the person can approve these. You cannot.
Tell them to expect the prompts and to approve what their jobs need. See
[macOS permissions](https://github.com/manikanta-kops/kipster-software-factory/blob/master/docs/macos-permissions.md).

## Optional: TypeSafe key

A TypeSafe key lets decision steps, such as judging whether a pull request is
safe to merge, run without the person. Without it, those decisions go to the
person. If they have a key, ask them to run this in their own terminal:

```sh
kf secret set typesafe
```

It reads the key hidden and saves it in the macOS credential store. Never put
it in environment variables, `.env` files, `config.json` or the chat.

## Updates

- The factory checks for a new release every few hours. When one exists, the
  web app shows **Update available** at the top right, and `kf status` shows it.
- **Update now** in the web app, or `kf update`, updates once running steps
  finish. New steps wait until then. The factory restarts on the new version.
- `kf update --now` installs at once and interrupts running steps.
- Between 2 and 5 AM, the factory installs a newer release by itself once no
  step is running. Turn this off in **Settings → Updates**.
- Configuration, secrets and the database are kept.

## When something fails

If `kf` is not found, use `~/.kipster-factory/current/bin/kf`.

| Problem                     | Do this                                                      |
| --------------------------- | ------------------------------------------------------------ |
| The service is not running  | `kf logs` shows its last 200 lines. `kf logs -f` follows it. |
| It is stuck or misbehaving  | `kf stop`, then `kf start`.                                  |
| An update failed            | Read `~/.kipster-factory/logs/update.log`.                   |
| Setup stopped with an error | Fix what it names, then run `kf setup --start`.              |

Never delete `~/.kipster-factory`. It holds the person's database, settings and
secrets. Do not reinstall over a failure without asking.

Report back to the person:

- what you ran and the last lines of its output
- the output of `kf status`
- their macOS version (`sw_vers -productVersion`) and processor (`uname -m`)
