#!/usr/bin/env bash
# Runs one candidate: a fresh copy of a task repo, one headless `claude -p` session with one
# plugin arm, then score.mjs. Usage: run-one.sh <batch-dir> <task> <arm> <rep>
# The batch dir's arms.tsv maps each arm to its plugin path; run.sh writes it.
# Must run outside any Claude Code sandbox: the candidate starts its own Bash sandbox and
# writes its transcript under ~/.claude/projects, which the Stop hook reads back.
set -euo pipefail

batch=${1:?batch dir} task=${2:?task} arm=${3:?arm} rep=${4:?rep}
here=$(cd "$(dirname "$0")" && pwd)
work_root=${WORK_ROOT:-$HOME/src/workbench}
model=${MODEL:-opus}
settings=$("$here/task-settings.sh" "$here/tasks/$task")
read -r minutes budget <<<"$settings"

plugin=$(awk -v a="$arm" '$1 == a { print $3 }' "$batch/arms.tsv")
[[ -n $plugin ]] || { echo "run-one: no arm $arm in $batch/arms.tsv" >&2; exit 2; }
run_dir="$batch/runs/$task-$arm-$rep"
mkdir -p "$run_dir" "$work_root"

# A project-shaped name, so the candidate's cwd says nothing about the run.
repo="$work_root/$task-$(openssl rand -hex 3)"
cp -R "$here/tasks/$task/repo" "$repo"
git -C "$repo" init -q -b main
git -C "$repo" add -A
GIT_AUTHOR_DATE=2026-09-01T12:00:00Z GIT_COMMITTER_DATE=2026-09-01T12:00:00Z \
  git -C "$repo" -c user.name=dev -c user.email=dev@example.com commit -q -m "Initial import"

jq -n --arg task "$task" --arg arm "$arm" --argjson rep "$rep" --arg repo "$repo" --arg plugin "$plugin" \
  --arg model "$model" --argjson minutes "$minutes" --argjson budget "$budget" \
  '{task: $task, arm: $arm, rep: $rep, repo: $repo, plugin: $plugin, model: $model, minutes: $minutes, budget: $budget}' \
  >"$run_dir/meta.json"

prompt="/pstack:poteto-mode $(cat "$here/tasks/$task/prompt.txt")"
started=$(date +%s)
set +e
(
  cd "$repo"
  # The settings flag keeps an installed copy of pstack from loading beside the arm.
  timeout "$((minutes * 60))" claude -p "$prompt" \
    --plugin-dir "$plugin" \
    --settings '{"enabledPlugins":{"pstack@pstack-claude":false}}' \
    --model "$model" \
    --strict-mcp-config \
    --permission-mode "${PERMISSION_MODE:-auto}" \
    --permission-prompts none \
    --max-budget-usd "$budget" \
    --verbose --include-hook-events --output-format stream-json \
    </dev/null >"$run_dir/out.jsonl" 2>"$run_dir/err.log"
)
status=$?
set -e
echo "{\"exit\": $status, \"seconds\": $(($(date +%s) - started))}" >"$run_dir/exit.json"

node "$here/score.mjs" "$run_dir" >/dev/null || echo "run-one: scoring $run_dir failed" >&2
echo "$task $arm $rep exit=$status"
