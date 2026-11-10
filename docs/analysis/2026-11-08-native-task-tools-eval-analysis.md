# Native task tools retest: results

Retest of nichenke/harness-config#527 on the harness at fork commit `629b96e`, 5 reps per task and arm, two Claude batches and two Codex batches ending 2026-11-08. Arms: `native` (Claude `TaskCreate`/`TaskUpdate`, Codex `update_plan`, no Stop hook), `todo` (`todo.md`, no hook), `todo-hook` (`todo.md` plus `run-gate`). Claude cost was $48.50 for stage 1 and $106.45 for stage 2.

| | Claude native | Claude todo | Claude todo-hook | Codex native | Codex todo | Codex todo-hook |
| --- | --- | --- | --- | --- | --- | --- |
| Stage 1, short tasks: held-out tests pass | 15/15 | 15/15 | 15/15 | 15/15 | 15/15 | 15/15 |
| Stage 1: every list resolved | 15/15 | 14/15 | 14/15 | 15/15 | 15/15 | 15/15 |
| Stage 1: runs with a box ticked but no proof of the work | 1 | 4 | 1 | 0 | 3 | 5 |
| Stage 2, logsift: held-out tests pass | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 | 5/5 |
| Stage 2: stopped with 8 steps open | 1/5 | 1/5 | 2/5 | 0/5 | 0/5 | 0/5 |
| Stage 2: ended with a delegate in flight | 0/5 | 0/5 | 0/5 | 1/5 | 2/5 | 0/5 |
| Stops held by run-gate (both stages) | 0 | 0 | 1 | 0 | 0 | 0 |
| Stage 2: USD per run | 7.6 | 7.7 | 6.0 | n/a | n/a | n/a |

## Findings

- **Native matches or beats todo.md on both runtimes (measured).** Every native run opened its list before its first edit. Native also had the fewest boxes ticked without proof.
- **The Stop hook shows no measurable benefit (measured).** It held one stop in the 40 runs of the two todo-hook arms (Claude todo-hook logsift rep 1, which then finished). The [2026-10-04 analysis](2026-10-04-run-gate-eval-analysis.md) found the same.
- **The early stops are a delegate-wait failure that every Claude arm shares (measured).** All 4 early stops launched a delegate with `run_in_background: true` and then ended the turn on "I'll review its diff once it reports back". `run-gate` lets that stop through by design (`plugins/pstack/hooks/run-gate.mjs:4-8` at `629b96e`), so a native-plus-hook arm would not catch this failure. Whether this happens in interactive sessions, or only under headless `claude -p`, is not yet settled (inferred: a waiting session resumes when the delegate finishes).
- **Codex native rewords the playbook steps (measured).** It kept 69.7% of steps word for word in stage 1 and 34.5% in stage 2. The lowest-scoring runs were checked by hand, including logsift rep 2, which scored PR as missing. The steps and skip reasons were present but merged or condensed, so this is the scorer's word-for-word matching, not dropped work.
- **On Codex, todo.md arms ended with a delegate in flight 6 times across both stages; native did once (measured).**

## Decision

The owner adopted the native task tools on both runtimes and retired `open-run`'s writer, `todo.md` as the primary list, and `run-gate` in one change. `todo.md` stays as the fallback for a runtime with no task tool. The background-delegate early stop is tracked separately as harness-config #539, and its first step is to reproduce it interactively. No native-plus-hook arm was run, because the hook exempts the one failure mode observed.

## Harness

The result directories were gitignored, and the harness is deleted in the change that adopts this decision. The harness is recoverable at fork commit `629b96e`, under `evals/run-gate/`.
