#!/bin/sh
# Installs or updates the Kipster Software Factory on macOS:
#
#   curl -fsSL https://github.com/manikanta-kops/kipster-software-factory/releases/latest/download/install.sh | sh
#
# Re-run it to update. Your configuration, secrets and database are kept.
set -eu

REPOSITORY="manikanta-kops/kipster-software-factory"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

  --home <dir>        Factory home (default: ~/.kipster-factory)
  --bin-dir <dir>     Where to link the kf command (default: ~/.local/bin)
  --version <tag>     Install this release tag instead of the latest (e.g. v0.1.0)
  --from <dir>        Install from a local directory with the archive and SHA256SUMS
  --no-start          Configure but do not start the background service
  --no-modify-path    Do not add the kf directory to your shell profile
EOF
}

if [ -t 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$(printf '\033[1m') dim=$(printf '\033[2m') green=$(printf '\033[32m')
  cyan=$(printf '\033[36m') red=$(printf '\033[31m') yellow=$(printf '\033[33m')
  reset=$(printf '\033[0m')
else
  bold='' dim='' green='' cyan='' red='' yellow='' reset=''
fi

bar() { printf '%s│%s\n' "$dim" "$reset"; }
step() { printf '%s◇%s  %-10s %s\n' "$green" "$reset" "$1" "$2"; }
note() { printf '%s│%s  %s\n' "$dim" "$reset" "$1"; }
warn() { printf '%s▲%s  %s\n' "$yellow" "$reset" "$1"; }
fail() {
  printf '%s■%s  %s\n' "$red" "$reset" "$1" >&2
  exit 1
}
tilde() {
  case $1 in
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

main() {
  home="$HOME/.kipster-factory"
  bin_dir="$HOME/.local/bin"
  release="latest"
  from=""
  start=1
  modify_path=1
  while [ $# -gt 0 ]; do
    case $1 in
      --home | --bin-dir | --version | --from)
        [ $# -ge 2 ] || fail "$1 needs a value."
        case $1 in
          --home) home=$2 ;;
          --bin-dir) bin_dir=$2 ;;
          --version) release=$2 ;;
          --from) from=$2 ;;
        esac
        shift 2
        ;;
      --no-start) start=0 && shift ;;
      --no-modify-path) modify_path=0 && shift ;;
      -h | --help) usage && return 0 ;;
      *) fail "Unknown option $1. See --help." ;;
    esac
  done

  printf '%s┌%s  %sInstalling Kipster Software Factory%s\n' "$dim" "$reset" "$bold" "$reset"
  bar

  [ "$(uname -s)" = "Darwin" ] || fail "Kipster Software Factory installs on macOS for now."
  case $(uname -m) in
    arm64) arch=arm64 ;;
    x86_64)
      # A shell under Rosetta reports x86_64 on Apple Silicon.
      if [ "$(sysctl -in sysctl.proc_translated 2>/dev/null)" = "1" ]; then arch=arm64; else arch=x64; fi
      ;;
    *) fail "Unsupported processor $(uname -m)." ;;
  esac
  if [ "$arch" = arm64 ]; then chip="Apple Silicon"; else chip="Intel"; fi
  step "Platform" "macOS $(sw_vers -productVersion 2>/dev/null || true) · $chip"
  for tool in curl tar shasum; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is required but was not found."
  done

  asset="kf-darwin-$arch.tar.gz"
  mkdir -p "$home/versions"
  chmod 700 "$home"
  work=$(mktemp -d "$home/versions/.incoming.XXXXXX")
  trap 'rm -rf "$work"' EXIT INT TERM

  if [ -n "$from" ]; then
    cp "$from/$asset" "$from/SHA256SUMS" "$work/" 2>/dev/null ||
      fail "$from must contain $asset and SHA256SUMS."
    step "Bundle" "$(tilde "$from")/$asset"
  else
    if [ "$release" = latest ]; then
      base="https://github.com/$REPOSITORY/releases/latest/download"
    else
      base="https://github.com/$REPOSITORY/releases/download/$release"
    fi
    curl -fsSL "$base/SHA256SUMS" -o "$work/SHA256SUMS" ||
      fail "Could not download the $release release. Check your connection or the --version tag."
    step "Download" "$asset"
    if [ -t 1 ]; then
      curl -fL --progress-bar "$base/$asset" -o "$work/$asset" || fail "Download failed."
    else
      curl -fsSL "$base/$asset" -o "$work/$asset" || fail "Download failed."
    fi
  fi

  expected=$(awk -v file="$asset" '$2 == file { print $1 }' "$work/SHA256SUMS")
  [ -n "$expected" ] || fail "SHA256SUMS has no entry for $asset."
  actual=$(shasum -a 256 "$work/$asset" | awk '{ print $1 }')
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $asset; nothing was installed."
  step "Verified" "SHA-256 matches the release checksum"

  tar -xzf "$work/$asset" -C "$work"
  bundle="$work/kf-darwin-$arch"
  version=$(cat "$bundle/VERSION")
  case $version in
    '' | *[!0-9A-Za-z.-]*) fail "The archive has an invalid version." ;;
  esac

  previous=""
  if [ -L "$home/current" ]; then
    previous=$(readlink "$home/current")
    if [ -x "$home/current/bin/kf" ] &&
      "$home/current/bin/kf" stop --home "$home" >/dev/null 2>&1; then
      note "Stopped the running factory for the update."
    fi
  fi
  rm -rf "$home/versions/$version"
  mv "$bundle" "$home/versions/$version"
  ln -sfn "versions/$version" "$home/current"
  for old in "$home"/versions/*; do
    [ -d "$old" ] || continue
    case "versions/${old##*/}" in
      "versions/$version" | "$previous") ;;
      *) rm -rf "$old" ;;
    esac
  done
  step "Installed" "$version in $(tilde "$home/versions/$version")"

  kf="$home/current/bin/kf"
  mkdir -p "$bin_dir"
  if [ -e "$bin_dir/kf" ] && [ ! -L "$bin_dir/kf" ]; then
    warn "$(tilde "$bin_dir/kf") exists and is not a link; left it alone. Run $(tilde "$kf") instead."
  else
    ln -sfn "$kf" "$bin_dir/kf"
    step "Command" "kf → $(tilde "$bin_dir/kf")"
  fi
  case ":$PATH:" in
    *":$bin_dir:"*) on_path=1 ;;
    *) on_path=0 ;;
  esac
  if [ "$on_path" = 0 ] && [ "$modify_path" = 1 ]; then
    case ${SHELL##*/} in
      zsh) profile="${ZDOTDIR:-$HOME}/.zshrc" ;;
      bash) profile="$HOME/.bash_profile" ;;
      *) profile="$HOME/.profile" ;;
    esac
    marker="# Added by the Kipster Software Factory installer"
    if ! grep -qF "$marker" "$profile" 2>/dev/null; then
      # shellcheck disable=SC2016 # $PATH is written literally into the profile.
      printf '\n%s\nexport PATH="%s:$PATH"\n' "$marker" "$bin_dir" >>"$profile"
      step "PATH" "added $(tilde "$bin_dir") to $(tilde "$profile")"
    fi
  fi
  printf '%s└%s  Installed\n\n' "$dim" "$reset"

  set -- setup --home "$home"
  [ "$start" = 1 ] && set -- "$@" --start
  # Under curl | sh the script arrives on stdin, so prompts read the terminal directly.
  if [ -t 1 ] && (exec </dev/tty) 2>/dev/null; then
    "$kf" "$@" </dev/tty || fail "Setup did not finish. Fix the issue above, then run: kf setup --start"
  else
    "$kf" "$@" --non-interactive </dev/null || fail "Setup did not finish. Fix the issue above, then run: kf setup --start"
  fi

  if [ "$on_path" = 0 ]; then
    # shellcheck disable=SC2016 # The command is shown literally.
    printf '\n%sOpen a new terminal to use %skf%s, or run: export PATH="%s:$PATH"\n' \
      "$dim" "$cyan" "$dim" "$bin_dir"
    printf '%s' "$reset"
  fi
  if [ "$start" = 1 ] && [ -t 1 ]; then
    port=$(sed -n 's/^ *"port": *\([0-9]*\).*/\1/p' "$home/config.json")
    open "http://localhost:${port:-4600}" 2>/dev/null || true
  fi
}

main "$@"
