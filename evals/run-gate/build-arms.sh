#!/usr/bin/env bash
# Builds the three plugin trees under <dest>/<label>/pstack and prints "arm label path" per line.
#   upstream   UPSTREAM_REV (default origin/main): the unforked port
#   prose      FORK_REV (default HEAD) without the run-gate Stop hook or the sentence naming it
#   hook       FORK_REV as is
# Labels are random so a candidate's skill base directory names no arm.
set -euo pipefail

dest=${1:?usage: build-arms.sh <dest>}
repo=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
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
    upstream) extract "$upstream_rev" "$target" ;;
    *) extract "$fork_rev" "$target" ;;
  esac
  if [[ $arm == prose ]]; then
    hooks="$target/hooks/hooks.json"
    jq 'del(.hooks.Stop)' "$hooks" >"$hooks.new" && mv "$hooks.new" "$hooks"
    skill="$target/skills/poteto-mode/SKILL.md"
    sentence=" On Claude Code the plugin's Stop hook runs the same check and holds the first stop while a line is open."
    grep -qF "$sentence" "$skill" || { echo "build-arms: the Stop hook sentence moved in $skill" >&2; exit 1; }
    python3 - "$skill" "$sentence" <<'EOF'
import sys
path, sentence = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(text.replace(sentence, "", 1))
EOF
  fi
  echo "$arm $lab $target"
done
