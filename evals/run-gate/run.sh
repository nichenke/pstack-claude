#!/usr/bin/env bash
# Runs the batch: every selected task x arm x rep in shuffled order, PARALLEL at a time, then the report.
# Usage: run.sh [--dry-run] [reps]   (default 5 reps of every task under tasks/ on every arm)
#        run.sh --smoke              (one hook-arm run of slugkit, to check the harness end to end)
# --dry-run prints the jobs, each task's settings and the cost ceiling, and starts nothing.
# Env: TASKS, ARMS (space-separated names), WORK_ROOT, MODEL, BUDGET_USD, RUN_MINUTES, PARALLEL,
# UPSTREAM_REV, FORK_REV. See README.md.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "run.sh: $*" >&2; exit 2; }

dry=false
case ${1:-} in
  -h | --help) sed -n '2,7s/^# \{0,1\}//p' "$0"; exit 0 ;;
  --dry-run) dry=true; shift ;;
esac
reps=${1:-5}
[[ $reps == --smoke || $reps =~ ^[1-9][0-9]*$ ]] || fail "reps must be a whole number above 0 or --smoke, got '$reps'"

known_arms=(upstream prose hook)
read -ra tasks <<<"${TASKS:-$(cd "$here/tasks" && echo *)}"
read -ra arms <<<"${ARMS:-${known_arms[*]}}"
if [[ $reps == --smoke ]]; then
  tasks=(slugkit) arms=(hook) reps=1
fi
[[ ${#tasks[@]} -gt 0 && ${#arms[@]} -gt 0 ]] || fail "TASKS and ARMS must each name at least one"
[[ -z $(printf '%s\n' "${tasks[@]}" | sort | uniq -d) ]] || fail "TASKS names a task twice"
[[ -z $(printf '%s\n' "${arms[@]}" | sort | uniq -d) ]] || fail "ARMS names an arm twice"
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
  for arm in "${arms[@]}"; do
    for ((rep = 1; rep <= reps; rep++)); do echo "$task $arm $rep"; done
  done
done | sort -R)
runs=$(wc -l <<<"$jobs" | tr -d ' ')
ceiling=$(awk 'NR == FNR { budget[$1] = $3; next } { sum += budget[$1] } END { printf "%.2f", sum }' \
  <(printf '%s' "$settings") <(printf '%s\n' "$jobs"))

if $dry; then
  echo "task minutes budget_usd"
  printf '%s' "$settings"
  echo "$runs runs on arms ${arms[*]}, ${PARALLEL:-3} at a time; cost ceiling \$$ceiling"
  exit 0
fi

# The candidates' transcripts land here and the Stop hook reads them back; a sandboxed shell cannot write it.
probe="$HOME/.claude/projects/.run-gate-write-probe"
if ! touch "$probe" 2>/dev/null; then
  echo "run.sh: cannot write ~/.claude/projects; run this outside Claude Code's sandbox (a terminal, or the ! prompt)." >&2
  exit 2
fi
rm -f "$probe"

batch="$here/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$batch/runs"
"$here/build-arms.sh" "${WORK_ROOT:-$HOME/src/workbench}/.plugins" >"$batch/arms.tsv"
git -C "$here" rev-parse "${FORK_REV:-HEAD}" "${UPSTREAM_REV:-origin/main}" >"$batch/revs.txt"
printf '%s' "$settings" >"$batch/settings.txt"
printf '%s\n' "$jobs" >"$batch/jobs.txt"

echo "batch $batch: $runs runs, ${PARALLEL:-3} at a time, cost ceiling \$$ceiling"
# shellcheck disable=SC2016 # $0..$3 expand inside the child bash, not here.
xargs -P "${PARALLEL:-3}" -L 1 bash -c '"$0" "$1" "$2" "$3" "$4" || true' "$here/run-one.sh" "$batch" <"$batch/jobs.txt" \
  | tee "$batch/progress.log"
node "$here/report.mjs" "$batch" | tee "$batch/report.md"
