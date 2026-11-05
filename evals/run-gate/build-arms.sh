#!/usr/bin/env bash
# Builds the three arms from FORK_REV (default HEAD) under <dest>/<label>/ and prints
# "arm label plugin codex-home codex-plugin" per line, with - for a Codex column not built.
# With --codex, each arm also gets a Codex home under <dest>/<label>/home with the arm installed
# from a local marketplace, auth.json and AGENTS.md linked from CODEX_AUTH_HOME (default ~/.codex).
# Labels are random so a candidate's skill base directory names no arm.
# Usage: build-arms.sh [--codex] <dest>
set -euo pipefail

codex=false
if [[ ${1:-} == --codex ]]; then codex=true; shift; fi
dest=${1:?usage: build-arms.sh [--codex] <dest>}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
fork_rev=${FORK_REV:-HEAD}
auth_home=${CODEX_AUTH_HOME:-$HOME/.codex}
codex_bin=${CODEX_BIN:-codex}

extract() {
  git -C "$repo" archive "$1" plugins/pstack | tar -x -C "$2"
}

codex_home() {
  local root=$1 home=$1/home
  mkdir -p "$root/.agents/plugins" "$home"
  jq -n '{name: "local", plugins: [{name: "pstack", source: {source: "local", path: "./plugins/pstack"},
    policy: {installation: "AVAILABLE", authentication: "ON_INSTALL", products: ["CODEX"]}}]}' \
    >"$root/.agents/plugins/marketplace.json"
  [[ -f $auth_home/auth.json ]] || { echo "build-arms: no $auth_home/auth.json; log in to Codex first" >&2; exit 1; }
  # Linked, not copied: a copy that refreshes its token would invalidate the original's.
  ln -s "$auth_home/auth.json" "$home/auth.json"
  if [[ -f $auth_home/AGENTS.md ]]; then ln -s "$auth_home/AGENTS.md" "$home/AGENTS.md"; fi
  CODEX_HOME=$home "$codex_bin" plugin marketplace add "$root" >/dev/null
  CODEX_HOME=$home "$codex_bin" plugin add pstack@local >/dev/null
  local installed=("$home"/plugins/cache/local/pstack/*)
  [[ ${#installed[@]} == 1 && -d ${installed[0]} ]] || { echo "build-arms: codex did not install the arm in $home" >&2; exit 1; }
  echo "$home ${installed[0]}"
}

mkdir -p "$dest"
for arm in native todo todo-hook; do
  lab=$(openssl rand -hex 2)
  root="$dest/$lab"
  target="$root/plugins/pstack"
  mkdir -p "$root"
  extract "$fork_rev" "$root"
  case $arm in
    native) "$here/strip-run-gate.sh" "$target" && node "$here/native-arm.mjs" "$target" && node "$here/codex-stop.mjs" --absent "$target" ;;
    todo) "$here/strip-run-gate.sh" "$target" && node "$here/codex-stop.mjs" --absent "$target" ;;
    todo-hook) "$here/strip-run-gate.sh" --verify "$target" && node "$here/codex-stop.mjs" "$target" ;;
  esac
  homes="- -"
  if $codex; then homes=$(codex_home "$root"); fi
  echo "$arm $lab $target $homes"
done
