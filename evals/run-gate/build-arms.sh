#!/usr/bin/env bash
# Builds the three plugin trees under <dest>/<label>/pstack and prints "arm label path" per line.
#   upstream   UPSTREAM_REV (default origin/main): the unforked port
#   prose      FORK_REV (default HEAD) through strip-run-gate.sh
#   hook       FORK_REV as is
# Labels are random so a candidate's skill base directory names no arm.
set -euo pipefail

dest=${1:?usage: build-arms.sh <dest>}
here=$(cd "$(dirname "$0")" && pwd)
repo=$(git -C "$here" rev-parse --show-toplevel)
upstream_rev=${UPSTREAM_REV:-origin/main}
fork_rev=${FORK_REV:-HEAD}

extract() { # rev target
  local tmp
  tmp=$(mktemp -d -p "${TMPDIR:-/tmp}")
  git -C "$repo" archive "$1" plugins/pstack | tar -x -C "$tmp"
  mkdir -p "$(dirname "$2")"
  mv "$tmp/plugins/pstack" "$2"
  rmdir "$tmp/plugins" "$tmp"
}

label() { openssl rand -hex 2; }

mkdir -p "$dest"
for arm in upstream prose hook; do
  lab=$(label)
  target="$dest/$lab/pstack"
  case $arm in
    upstream)
      extract "$upstream_rev" "$target"
      ! grep -rqF run-gate "$target" || { echo "build-arms: $upstream_rev already carries run-gate" >&2; exit 1; }
      ;;
    prose) extract "$fork_rev" "$target" && "$here/strip-run-gate.sh" "$target" ;;
    hook) extract "$fork_rev" "$target" && "$here/strip-run-gate.sh" --verify "$target" ;;
  esac
  echo "$arm $lab $target"
done
