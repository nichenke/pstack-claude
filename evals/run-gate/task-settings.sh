#!/usr/bin/env bash
# Prints "<minutes> <budget-usd>" for one task directory. Each comes from RUN_MINUTES or BUDGET_USD
# in the environment when set, else from the task's task.env, else 45 minutes and 10 USD.
# task.env holds only RUN_MINUTES=<n> and BUDGET_USD=<n> lines; anything else exits 2.
set -euo pipefail

dir=${1:?usage: task-settings.sh <task-dir>}
minutes=45 budget=10
fail() { echo "task-settings: $*" >&2; exit 2; }

if [[ -f $dir/task.env ]]; then
  while IFS= read -r line || [[ -n $line ]]; do
    case $line in
      '') ;;
      RUN_MINUTES=*) minutes=${line#*=} ;;
      BUDGET_USD=*) budget=${line#*=} ;;
      *) fail "$dir/task.env: unknown line '$line'" ;;
    esac
  done <"$dir/task.env"
fi
minutes=${RUN_MINUTES:-$minutes}
budget=${BUDGET_USD:-$budget}
[[ $minutes =~ ^[1-9][0-9]*$ ]] || fail "RUN_MINUTES for $dir must be a whole number above 0, got '$minutes'"
[[ $budget =~ ^(0|[1-9][0-9]*)(\.[0-9]+)?$ && $budget =~ [1-9] ]] || fail "BUDGET_USD for $dir must be a number above 0, got '$budget'"
echo "$minutes $budget"
