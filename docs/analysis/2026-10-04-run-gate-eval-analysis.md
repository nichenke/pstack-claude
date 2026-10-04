# run-gate eval: upstream vs prose-only vs hook

Batch `20261004-122856`, run with `evals/run-gate/run.sh` on 2026-10-04. Fork arms at `f90f6d0`, upstream arm at `c1123fe` (0.9.67). 45 runs (3 tasks x 3 arms x 5 reps) on `claude-opus-5-5` in auto permission mode, with the user's own settings and rules loaded. Every run finished without error. Total cost $49.30, about $1.10 a run.

## Results

| Metric | upstream | prose | hook |
| --- | --- | --- | --- |
| todo.md kept | 9/15 | 15/15 | 15/15 |
| todo.md fully resolved at the end | 2/15 | 15/15 | 15/15 |
| ran `--check` | 0/15 | 15/15 | 15/15 |
| stops held by run-gate | n/a | n/a | 0 in 15 runs |
| decision rows (mean) | 0.0 | 3.2 | 2.8 |
| deslop done / skipped / claimed / missing | 4 / 0 / 0 / 11 | 6 / 6 / 3 / 0 | 9 / 4 / 2 / 0 |
| no-comments done / skipped / claimed / missing | 1 / 0 / 0 / 14 | 1 / 14 / 0 / 0 | 0 / 15 / 0 / 0 |
| PR done / skipped / claimed / missing | 0 / 4 / 0 / 11 | 0 / 14 / 0 / 1 | 0 / 15 / 0 / 0 |
| held-out tests pass | 15/15 | 15/15 | 15/15 |
| turns (mean) | 12.3 | 13.4 | 14.5 |
| minutes (mean) | 2.2 | 2.8 | 2.3 |
| USD (mean) | 1.1 | 1.2 | 1.0 |

`skipped` means the gate's `todo.md` line carries a filled-in reason, and `claimed` means the line is checked off with no reason while the run never invoked the skill. Every PR skip in the fork arms names the "commit or push only when the user asks" rule or the missing remote.

## Findings

- **open-run and Start the run carry the effect (measured).** Upstream runs often started a list, 10 of 15 by hand, and then abandoned it. Only 2 of 15 ended fully resolved, and confload's ended with 7 or 8 open steps each. Both fork arms ended 15 of 15 resolved, ran `--check` every time, and handled the no-comments and PR gates in 29 of 30 and 29 of 30 runs, against 1 and 4 of 15 upstream.
- **The Stop hook did nothing measurable on these tasks (measured).** It never held a stop, because every fork-arm run resolved its list before stopping. Prose and hook arms are indistinguishable on every metric at n=15. The tasks run 2 to 3 minutes, so this says nothing about long runs where a list drifts, which is the case the hook exists for.
- **Correctness and cost are unchanged (measured).** Held-out tests passed 45 of 45. The fork arms cost one to two more turns and no more money.
- **A ticked box is not evidence (measured).** Five fork-arm runs checked off `/deslop` with a note such as "reviewed by hand" and never ran it. `--check` trusts `[x]`, so neither it nor the hook catches this.

## Limits

- "List before first edit" counts only the Edit and Write tools. Candidates often patch files through Bash, which makes that metric optimistic for every arm, so it is left out of the table above.
- Three small Python tasks routed to bug-fix, feature and refactoring. figure-it-out's checkpoint change was never exercised.
- One model, and the user's own rules loaded. A run with no user rules could differ.

## Recommendation

Keep `open-run.mjs`, **Start the run**, and **Precedence**. They turn an abandoned list into a resolved one at no cost to correctness or spend. Keep `run-gate.mjs` as cheap insurance rather than as a proven gain: it is port-owned, it never fired a false block here, and it lets the second stop through. The case against it is that 15 runs showed no effect. A long-task arm, such as a multi-file feature that runs past 20 minutes, is what would settle it. Make `/deslop` claims checkable before relying on the list as an audit, for example by having `--check` require a Skill invocation for a checked gate.
