#!/usr/bin/env bash
# Turns a fork plugin tree into the prose arm: unregisters the run-gate Stop hook and deletes the
# SKILL.md sentence that names it. Usage: strip-run-gate.sh [--verify] <plugin-root>
# --verify only checks that the tree still carries both, as the hook arm must.
# Every check runs before any write, so a tree that no longer matches fails with nothing changed,
# and the strip fails afterwards if any mention of the hook survives.
set -euo pipefail

verify=false
if [[ ${1:-} == --verify ]]; then verify=true; shift; fi
root=${1:?usage: strip-run-gate.sh [--verify] <plugin-root>}
hooks="$root/hooks/hooks.json"
skill="$root/skills/poteto-mode/SKILL.md"
gate="hooks/run-gate.mjs"
sentence=" On Claude Code the plugin's Stop hook runs the same check and holds the first stop while a line is open."

fail() { echo "strip-run-gate: $*" >&2; exit 1; }

[[ -f $hooks && -f $skill ]] || fail "$root is not a pstack plugin tree"
registered=$(jq --arg g "$gate" '[.hooks | to_entries[] | .key as $event | .value[].hooks[] | select(.command | contains($g)) | $event]' "$hooks")
[[ $registered == "$(jq -n '["Stop"]')" ]] || fail "expected one Stop hook running $gate in $hooks, found events $(jq -c . <<<"$registered")"
count=$({ grep -oF "$sentence" "$skill" || true; } | wc -l | tr -d ' ')
[[ $count == 1 ]] || fail "expected the Stop hook sentence once in $skill, found it $count times; update the sentence here to match"
$verify && exit 0

jq --arg g "$gate" '
  .hooks.Stop |= (map(.hooks |= map(select(.command | contains($g) | not))) | map(select(.hooks | length > 0)))
  | if .hooks.Stop == [] then del(.hooks.Stop) else . end' "$hooks" >"$hooks.new"
mv "$hooks.new" "$hooks"
python3 -I - "$skill" "$sentence" <<'EOF'
import sys
path, sentence = sys.argv[1], sys.argv[2]
text = open(path, encoding="utf-8").read()
open(path, "w", encoding="utf-8").write(text.replace(sentence, "", 1))
EOF

left=$(grep -rIil -e "run-gate" -e "stop hook" --exclude=run-gate.mjs "$root" || true)
[[ -z $left ]] || fail "the hook is still named after stripping, in: $left"
