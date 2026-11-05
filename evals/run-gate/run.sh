#!/usr/bin/env bash
# Runs the batch: every selected task x runtime x arm x rep in shuffled order, PARALLEL at a time,
# then the report.
# Usage: run.sh [--dry-run] [reps]   (default 5 reps of every task on every runtime and arm)
#        run.sh [--dry-run] --smoke  (one slugkit run per selected runtime and arm)
# --dry-run prints each task's settings, one "job <task> <runtime> <arm> <rep>" line per run and
# the cost ceiling, and starts nothing.
# Env: TASKS, RUNTIMES, ARMS (space-separated names), WORK_ROOT, MODEL, CODEX_MODEL, BUDGET_USD,
# RUN_MINUTES, PARALLEL, FORK_REV, CLAUDE_BIN, CODEX_BIN, CODEX_AUTH_HOME, CODEX_HOOKS. See README.md.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "run.sh: $*" >&2; exit 2; }

dry=false
case ${1:-} in
  -h | --help) sed -n '2,10s/^# \{0,1\}//p' "$0"; exit 0 ;;
  --dry-run) dry=true; shift ;;
esac
reps=${1:-5}
[[ $reps == --smoke || $reps =~ ^[1-9][0-9]*$ ]] || fail "reps must be a whole number above 0 or --smoke, got '$reps'"

known_runtimes=(claude codex)
known_arms=(native todo todo-hook)
read -ra tasks <<<"${TASKS:-$(cd "$here/tasks" && echo *)}"
read -ra runtimes <<<"${RUNTIMES:-${known_runtimes[*]}}"
read -ra arms <<<"${ARMS:-${known_arms[*]}}"
if [[ $reps == --smoke ]]; then
  tasks=(slugkit) reps=1
fi
[[ ${#tasks[@]} -gt 0 && ${#runtimes[@]} -gt 0 && ${#arms[@]} -gt 0 ]] || fail "TASKS, RUNTIMES and ARMS must each name at least one"
twice() { [[ -n $(printf '%s\n' "$@" | sort | uniq -d) ]]; }
if twice "${tasks[@]}"; then fail "TASKS names a task twice"; fi
if twice "${runtimes[@]}"; then fail "RUNTIMES names a runtime twice"; fi
if twice "${arms[@]}"; then fail "ARMS names an arm twice"; fi
for runtime in "${runtimes[@]}"; do
  [[ " ${known_runtimes[*]} " == *" $runtime "* ]] || fail "unknown runtime '$runtime'; runtimes are ${known_runtimes[*]}"
done
for arm in "${arms[@]}"; do
  [[ " ${known_arms[*]} " == *" $arm "* ]] || fail "unknown arm '$arm'; arms are ${known_arms[*]}"
done
settings=""
for task in "${tasks[@]}"; do
  dir="$here/tasks/$task"
  [[ $task =~ ^[a-z0-9-]+$ && -d $dir/repo && -f $dir/prompt.txt && -f $dir/hidden/test_hidden.py ]] \
    || fail "unknown task '$task'; tasks are $(cd "$here/tasks" && echo *)"
  settings+="$task $("$here/task-settings.sh" "$dir")"$'\n'
done

jobs=$(for task in "${tasks[@]}"; do
  for runtime in "${runtimes[@]}"; do
    for arm in "${arms[@]}"; do
      for ((rep = 1; rep <= reps; rep++)); do echo "$task $runtime $arm $rep"; done
    done
  done
done | sort -R)
runs=$(wc -l <<<"$jobs" | tr -d ' ')
# Claude runs are capped by --max-budget-usd; codex exec has no spend cap, so only the clock bounds it.
read -r claude_runs codex_runs ceiling codex_minutes < <(awk '
  NR == FNR { minutes[$1] = $2; budget[$1] = $3; next }
  $2 == "claude" { n++; usd += budget[$1] }
  $2 == "codex" { m++; mins += minutes[$1] }
  END { printf "%d %d %.2f %d\n", n, m, usd, mins }' <(printf '%s' "$settings") <(printf '%s\n' "$jobs"))
summary="$runs runs ($claude_runs claude, $codex_runs codex) on arms ${arms[*]}, ${PARALLEL:-3} at a time;"
summary+=" cost ceiling \$$ceiling for claude; codex uncapped in USD, at most $codex_minutes minutes"

if $dry; then
  echo "task minutes budget_usd"
  printf '%s' "$settings"
  sed 's/^/job /' <<<"$jobs"
  echo "$summary"
  exit 0
fi

has() { [[ " ${runtimes[*]} " == *" $1 "* ]]; }
if has claude; then
  # The candidates' transcripts land here and the Stop hook reads them back; a sandboxed shell cannot write it.
  probe="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects/.run-gate-write-probe"
  if ! touch "$probe" 2>/dev/null; then
    fail "cannot write ${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects; run this outside Claude Code's sandbox (a terminal, or the ! prompt)."
  fi
  rm -f "$probe"
fi
if has codex && [[ ${CODEX_HOOKS:-} != bypass ]]; then
  fail "codex runs need CODEX_HOOKS=bypass: every arm's hooks are rebuilt per batch, so none carries persisted trust, and run-one.sh passes --dangerously-bypass-hook-trust only when you opt in."
fi

batch="$here/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$batch/runs"
build=()
if has codex; then build=(--codex); fi
"$here/build-arms.sh" ${build[@]+"${build[@]}"} "${WORK_ROOT:-$HOME/src/workbench}/.plugins" >"$batch/arms.tsv"
git -C "$here" rev-parse "${FORK_REV:-HEAD}" >"$batch/revs.txt"
printf '%s' "$settings" >"$batch/settings.txt"
printf '%s\n' "$jobs" >"$batch/jobs.txt"

echo "batch $batch: $summary"
# shellcheck disable=SC2016 # $0..$5 expand inside the child bash, not here.
xargs -P "${PARALLEL:-3}" -L 1 bash -c '"$0" "$1" "$2" "$3" "$4" "$5" || true' "$here/run-one.sh" "$batch" <"$batch/jobs.txt" \
  | tee "$batch/progress.log"
node "$here/report.mjs" "$batch" | tee "$batch/report.md"
