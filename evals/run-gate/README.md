# run-gate eval

Measures whether the 0.9.68 fork changes what a poteto-mode run does. The fork adds `open-run.mjs`, **Start the run**, **Precedence**, and the `run-gate.mjs` Stop hook. The run-time question is whether runs open their todolist before editing, keep it current, and reach or explicitly skip the commit and PR gates. The cost question is whether that costs correctness, turns, or money.

## Arms

`build-arms.sh` builds each arm from git, so uncommitted edits never reach a candidate.

| Arm | Source | What it isolates |
| --- | --- | --- |
| `upstream` | `UPSTREAM_REV`, default `origin/main` | the unforked port |
| `prose` | `FORK_REV`, default `HEAD`, minus the Stop hook and the sentence that names it | the skill text and `open-run.mjs` alone |
| `hook` | `FORK_REV` as is | the full fork |

`strip-run-gate.sh` makes the prose arm. It fails the build, before writing anything, unless the tree registers exactly one Stop hook running `run-gate.mjs` and `SKILL.md` carries the sentence exactly once, and fails after the strip if any file still names the hook. The hook arm gets the same checks with `--verify`. When a rewording breaks the build, update the sentence in the script.

## Tasks

Each task is a small Python repo under `tasks/<name>/repo` with passing visible tests, an organic prompt in `prompt.txt`, and held-out tests in `hidden/` that the candidate never sees. The held-out tests fail on the original repo and pass on a reference fix. A task may carry `reference.patch` and `task.env` beside `repo/`; `run-one.sh` copies only `repo/`. `tests/run-gate-eval-tasks.test.mjs` checks each task's tests fail on its repo, and that a `reference.patch` makes them pass.

| Task | Playbook it should route to | Held-out check |
| --- | --- | --- |
| `slugkit` | bug-fix | separators collapse and never lead or trail |
| `tally` | feature | `--json` shape, stdin as `-`, plain output unchanged |
| `confload` | refactoring | behaviour unchanged, unquoting written once |
| `logsift` | feature, or figure-it-out as an ambitious multi-part change | JSON lines, `.gz` input, `--since`/`--until`, `--min-level`, `--by`, `--format`, `logsift.toml`, `--strict`; table output unchanged |

The first three averaged 1 to 6 minutes a run in the 2026-10-04 batch, too short for a list to drift. `logsift` asks for eight parts across a package so that a run passes 20 minutes, which is a guess until a batch measures it. Its `task.env` raises its limits to 90 minutes and 30 USD.

## Running

Run from a terminal or the `!` prompt, not from a sandboxed Claude Code shell. A candidate starts its own Bash sandbox and writes its transcript under `~/.claude/projects`, where `run-gate.mjs` reads it back. `run.sh` refuses to start when it cannot write there.

```sh
evals/run-gate/run.sh --smoke      # one hook-arm run of slugkit
evals/run-gate/run.sh --dry-run 5  # print the jobs, limits and cost ceiling; start nothing
evals/run-gate/run.sh 5            # every task x every arm x 5 reps, shuffled
```

`TASKS` and `ARMS` restrict a batch to space-separated names, and `run.sh` rejects an unknown or repeated name before it builds anything. The suggested batch is two invocations from the repository root:

```sh
export CLAUDE_CODE_ENABLE_TODO_TOOLS=1
TASKS="slugkit tally confload" ARMS="upstream hook" evals/run-gate/run.sh 5  # 30 runs
TASKS=logsift evals/run-gate/run.sh 5                                         # 15 runs, all three arms
```

Prose and hook were indistinguishable on the short tasks, so the first batch drops prose. `claude -p` offers no `TaskCreate` or `TodoWrite` unless `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` is set. Without it, upstream falls back to `todo.md`, as in the 2026-10-04 batch. The cost ceiling is runs x `BUDGET_USD`: 30 x 10 = 300 USD for the first batch and 15 x 30 = 450 USD for the second. The short tasks averaged about 1.10 USD a run, so the first should cost about 33 USD. The second has no measured cost.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORK_ROOT` | `~/src/workbench` | candidate repos and the built arms (`.plugins/<label>`) |
| `MODEL` | `opus` | candidate model |
| `TASKS` | every directory under `tasks/` | tasks to run |
| `ARMS` | `upstream prose hook` | arms to run |
| `BUDGET_USD` | `10`, or the task's `task.env` | `--max-budget-usd` per run |
| `RUN_MINUTES` | `45`, or the task's `task.env` | wall-clock cap per run |
| `PARALLEL` | `3` | concurrent runs |

An exported `BUDGET_USD` or `RUN_MINUTES` wins over a task's `task.env`.

Each run starts as `/pstack:poteto-mode <prompt>` with `--strict-mcp-config`, `--permission-mode auto`, and `--permission-prompts none`, and with an installed `pstack@pstack-claude` disabled so only the arm loads. The user's own settings, rules, and other plugins load as they would in a real session, and the same for every arm.

Results land in `results/<timestamp>/`, which git ignores: `arms.tsv` maps arm to label, `settings.txt` holds each task's limits, and `runs/<task>-<arm>-<rep>/` holds the stream, the copied `todo.md` and `decisions.tsv`, and `score.json`. `report.md` holds the per-arm table and the per-task breakdowns.

## Scoring

`score.mjs` reads the stream-json, never the candidate's own account of what it did. A list opened or an edit made by a subagent does not count for the main run, while a gate skill a subagent ran does. A gate counts as `skipped` only when its `todo.md` line carries a filled-in `skip:` or `n/a:` reason, as `open-run.mjs --check` requires, and as `claimed` when the line is checked off but the run never invoked it. The native task list is the main thread's `TaskCreate` tasks under their last `TaskUpdate` status, or its last `TodoWrite`, and a task still open is any not `completed`. `tests/run-gate-eval-score.test.mjs` covers the stream rules.

## Blinding

Candidate-visible paths and prompts carry no eval vocabulary. Repos are named `<task>-<random>`, arms sit under random labels, and the mapping stays in the batch directory. The eval playbook's blinded judge is left out, because every metric here is a deterministic check on the stream or the repo, and the one quality signal is the held-out tests.
