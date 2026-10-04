#!/usr/bin/env bash
# Runs the batch: every task x arm x rep in shuffled order, PARALLEL at a time, then the report.
# Usage: run.sh [reps]          (default 5; 3 tasks x 3 arms x 5 = 45 runs)
#        run.sh --smoke         (one hook-arm run of slugkit, to check the harness end to end)
# Env: WORK_ROOT, MODEL, BUDGET_USD, RUN_MINUTES, PARALLEL, UPSTREAM_REV, FORK_REV. See README.md.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
reps=${1:-5}
batch="$here/results/$(date +%Y%m%d-%H%M%S)"
mkdir -p "$batch/runs"

# The candidates' transcripts land here and the Stop hook reads them back; a sandboxed shell cannot write it.
probe="$HOME/.claude/projects/.run-gate-write-probe"
if ! touch "$probe" 2>/dev/null; then
  echo "run.sh: cannot write ~/.claude/projects; run this outside Claude Code's sandbox (a terminal, or the ! prompt)." >&2
  exit 2
fi
rm -f "$probe"

"$here/build-arms.sh" "${WORK_ROOT:-$HOME/src/workbench}/.plugins" >"$batch/arms.tsv"
git -C "$here" rev-parse "${FORK_REV:-HEAD}" "${UPSTREAM_REV:-origin/main}" >"$batch/revs.txt"

if [[ $reps == --smoke ]]; then
  "$here/run-one.sh" "$batch" slugkit hook 1
  node "$here/report.mjs" "$batch"
  exit 0
fi

jobs="$batch/jobs.txt"
for task in slugkit tally confload; do
  for arm in upstream prose hook; do
    for ((rep = 1; rep <= reps; rep++)); do echo "$task $arm $rep"; done
  done
done | sort -R >"$jobs"

echo "batch $batch: $(wc -l <"$jobs" | tr -d ' ') runs, ${PARALLEL:-3} at a time"
# shellcheck disable=SC2016 # $0..$3 expand inside the child bash, not here.
xargs -P "${PARALLEL:-3}" -L 1 bash -c '"$0" "$1" "$2" "$3" "$4" || true' "$here/run-one.sh" "$batch" <"$jobs" \
  | tee "$batch/progress.log"
node "$here/report.mjs" "$batch" | tee "$batch/report.md"
