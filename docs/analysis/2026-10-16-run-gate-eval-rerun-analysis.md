# run-gate eval re-run: current upstream, native task tools, a long task

Three batches run with `evals/run-gate/run.sh` on 2026-10-16, fork arms at `5c8b7dc` (0.9.89), upstream arm at `963781d` (0.9.88), `claude-opus-5-5`, auto permission mode, the user's own settings and rules loaded, 3 runs at a time. Total cost $161.48.

| Batch | Tasks | Arms | Runs | USD |
| --- | --- | --- | --- | --- |
| `20261016-164218` | slugkit, tally, confload | upstream, hook | 30 | 27.34 |
| `20261016-170236` | logsift | upstream, prose, hook | 15 | 120.28 |
| `20261016-193113` | slugkit, tally, confload, `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` | upstream | 15 | 13.86 |

## Short tasks: the list mechanism is still needed (measured)

| Metric | upstream | upstream + task tools | hook |
| --- | --- | --- | --- |
| every list kept fully resolved | 2/15 | 3/15 | 15/15 |
| list opened before first edit | 6/15 | 7/15 | 15/15 |
| task-tool list kept / resolved | 0 / 0 | 3 / 1 | 0 / 0 |
| PR gate done or skipped with a reason | 2/15 | 2/15 | 15/15 |
| held-out tests pass | 15/15 | 15/15 | 15/15 |
| USD (mean) | 0.9 | 0.9 | 0.9 |

- Current upstream abandons the list as often as 0.9.67 did on 2026-10-04 (2/15 then and now).
- Turning native task tools on does not close the gap. Only 3 of 15 runs used them, and 1 of those resolved its list.
- Headless `claude -p` offers no task tools unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set. The interactive session that ran this analysis had none either, so the unset batch matches how the user works.
- The run gate held no stop on short tasks, as before. One path collision (slugkit-hook-4 and -5) did not change either run's result.

## Long task: the gate fires, the comparison is inconclusive

| Run wall-clock minutes (from `seconds`) | upstream | prose | hook |
| --- | --- | --- | --- |
| per run | 48, 26, 33, 25, 58 | 90 (timeout), 12, 12, 20, 12 | 24, 12, 29, 14, 14 |
| USD (mean) | 11.2 | 7.1 | 5.7 |
| every list kept fully resolved | 1/5 | 1/5 | 3/5 |
| runs with a stop held | 0/5 | 0/5 | 5/5 |
| held-out tests pass | 5/5 | 5/5 | 4/5 |

- **The gate fires on long runs (measured).** It held a stop in all 5 hook runs, 1.6 times a run on average. This is the first batch where it held anything.
- **Concurrent runs shared one list (measured).** All runs share the user's `$TMPDIR`, `/tmp/claude-501`. 7 of the 10 fork-arm runs opened or adopted `/tmp/claude-501/logsift-run/todo.md`, because `open-run.mjs` answers an existing list with `exists; left as is` and the run then uses it. hook-2 and prose-2 worked from that shared list. hook-1, -3 and -4 were held on a list another run owned. Each refused to tick another session's steps, and the gate held them anyway.
- **Headless runs end with a delegate in flight (measured).** 4 fork-arm runs (hook-2, prose-2, -3, -5) stopped at about 12 minutes, saying they would finish when a background delegate reported. A `-p` run never resumes after that, so their open steps measure the harness mode as much as the agent. The gate cannot help there, because it lets the second stop through. The work landed in 3 of the 4. hook-2 is the one held-out failure.
- So the hook-vs-prose difference (3/5 vs 1/5 resolved) is not evidence either way.

## Defects found

1. **open-run adopts another session's list (product).** Two sessions that pick the same work dir share one `todo.md`, and the gate then holds each on the other's steps. This is the same false positive the session that set up this batch hit with a preview run. Fix: have `open-run.mjs` write the session id (`CLAUDE_CODE_SESSION_ID`, present in Bash) into the list, refuse an existing list with a different id, and have `run-gate.mjs` count only a list whose id matches the hook input's `session_id`.
2. **The harness shares `$TMPDIR` across concurrent runs (eval).** Give each run its own `TMPDIR` in `run-one.sh` so arms cannot interfere, and keep fix 1's test as the check on the shared case.
3. **report.mjs minutes use `duration_ms` (eval).** In a run that delegates, that covers only the main thread's last stretch, so it reported 2 to 4 minutes for runs of 12 to 90. Use the wall-clock `seconds` the score already records.
4. **report.mjs counts a timeout as finished without error (eval).** prose-1 exited 124 at the 90-minute cap and was reported as 5/5 clean.
5. **Background delegates end headless runs early (eval).** Either keep the candidate session open until its background agents finish, or record "stopped with a delegate in flight" as its own outcome, so that open steps measure discipline rather than harness mode.

## Recommendation

- Keep `open-run.mjs`, **Start the run** and `--check`. Two batches against two upstream versions agree, and native task tools are no substitute.
- Fix defect 1 before relying on the gate across concurrent sessions, then defects 2 to 5.
- Re-run the long task on prose and hook arms only, after those fixes. The upstream long arm never used `open-run`, so it was not contaminated. With 10 runs an arm at the measured $5.7 to $7.1 a run, that is about $130 (a ceiling of $600 at the $30 per-run cap).
