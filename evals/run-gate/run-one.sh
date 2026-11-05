#!/usr/bin/env bash
# Runs one candidate: a fresh copy of a task repo, one headless session on one runtime with one
# plugin arm, then score.mjs. Usage: run-one.sh <batch-dir> <task> <runtime> <arm> <rep>
# The batch dir's arms.tsv maps each arm to its plugin tree and Codex home; run.sh writes it.
# A claude run must start outside any Claude Code sandbox: the candidate starts its own Bash
# sandbox and writes its transcript under ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects, which the
# Stop hook reads back. A codex run runs under codex's workspace-write sandbox.
set -euo pipefail

batch=${1:?batch dir} task=${2:?task} runtime=${3:?runtime} arm=${4:?arm} rep=${5:?rep}
here=$(cd "$(dirname "$0")" && pwd)
work_root=${WORK_ROOT:-$HOME/src/workbench}
settings=$("$here/task-settings.sh" "$here/tasks/$task")
read -r minutes budget <<<"$settings"

read -r plugin codex_home codex_plugin < <(awk -v a="$arm" '$1 == a { print $3, $4, $5 }' "$batch/arms.tsv") || true
[[ -n ${plugin:-} ]] || { echo "run-one: no arm $arm in $batch/arms.tsv" >&2; exit 2; }
case $runtime in
  claude) model=${MODEL:-opus} ;;
  codex)
    [[ -d $codex_home ]] || { echo "run-one: arm $arm has no Codex home; build-arms.sh needs --codex" >&2; exit 2; }
    plugin=$codex_plugin model=${CODEX_MODEL:-} ;;
  *) echo "run-one: unknown runtime $runtime" >&2; exit 2 ;;
esac
run_dir="$batch/runs/$task-$runtime-$arm-$rep"
mkdir -p "$run_dir" "$work_root/.tmp"

# A project-shaped name, so the candidate's cwd says nothing about the run.
repo="$work_root/$task-$(openssl rand -hex 3)"
cp -R "$here/tasks/$task/repo" "$repo"
git -C "$repo" init -q -b main
git -C "$repo" add -A
GIT_AUTHOR_DATE=2026-09-01T12:00:00Z GIT_COMMITTER_DATE=2026-09-01T12:00:00Z \
  git -C "$repo" -c user.name=dev -c user.email=dev@example.com commit -q -m "Initial import"
# Concurrent runs share no temp dir, so no run can pick up another's scratch files.
run_tmp=$(mktemp -d -p "$work_root/.tmp")

jq -n --arg task "$task" --arg runtime "$runtime" --arg arm "$arm" --argjson rep "$rep" --arg repo "$repo" \
  --arg plugin "$plugin" --arg model "$model" --argjson minutes "$minutes" --argjson budget "$budget" --arg tmp "$run_tmp" \
  '{task: $task, runtime: $runtime, arm: $arm, rep: $rep, repo: $repo, plugin: $plugin, model: $model,
    minutes: $minutes, budget: (if $runtime == "claude" then $budget else null end), tmp: $tmp}' \
  >"$run_dir/meta.json"

prompt_text=$(cat "$here/tasks/$task/prompt.txt")
started=$(date +%s)
set +e
if [[ $runtime == claude ]]; then
  native=()
  if [[ $arm == native ]]; then native=(CLAUDE_CODE_ENABLE_TODO_TOOLS=1); fi
  (
    cd "$repo"
    # The settings flag keeps an installed copy of pstack from loading beside the arm. The env
    # scrub keeps a Codex parent's thread id out of open-run's session stamp.
    env -u CODEX_THREAD_ID -u CODEX_SESSION_ID -u CLAUDE_CODE_ENABLE_TODO_TOOLS TMPDIR="$run_tmp" ${native[@]+"${native[@]}"} \
      timeout "$((minutes * 60))" "${CLAUDE_BIN:-claude}" -p "/pstack:poteto-mode $prompt_text" \
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
else
  flags=()
  if [[ $arm == native ]]; then flags+=(-c tools.update_plan.enabled=true); fi
  if [[ -n $model ]]; then flags+=(-m "$model"); fi
  # run.sh refuses a codex batch unless CODEX_HOOKS=bypass: the per-batch homes carry no hook trust.
  if [[ ${CODEX_HOOKS:-} == bypass ]]; then flags+=(--dangerously-bypass-hook-trust); fi
  # The env scrub keeps a Claude Code parent's session id out of open-run's session stamp.
  env -u CLAUDE_CODE_SESSION_ID -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT -u CLAUDE_PLUGIN_ROOT \
    CODEX_HOME="$codex_home" TMPDIR="$run_tmp" \
    timeout "$((minutes * 60))" "${CODEX_BIN:-codex}" exec --json -C "$repo" --sandbox workspace-write \
    -c approval_policy='"never"' ${flags[@]+"${flags[@]}"} "\$pstack:poteto-mode $prompt_text" \
    </dev/null >"$run_dir/out.jsonl" 2>"$run_dir/err.log"
fi
status=$?
set -e
echo "{\"exit\": $status, \"seconds\": $(($(date +%s) - started))}" >"$run_dir/exit.json"

if [[ $runtime == codex ]]; then
  thread=$(jq -r 'select(.type == "thread.started") | .thread_id' "$run_dir/out.jsonl" 2>/dev/null | head -1)
  rollout=$(find "$codex_home/sessions" -name "rollout-*-$thread.jsonl" 2>/dev/null | head -1)
  if [[ -n $thread && -n $rollout ]]; then cp "$rollout" "$run_dir/rollout.jsonl"; fi
fi

node "$here/score.mjs" "$run_dir" >/dev/null || echo "run-one: scoring $run_dir failed" >&2
rm -r "$run_tmp"
echo "$task $runtime $arm $rep exit=$status"
