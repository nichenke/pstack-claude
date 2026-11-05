# run-gate eval

Measures how a poteto-mode run keeps its todolist on Claude Code and on Codex, three ways: the runtime's own task tool, open-run's `todo.md`, and `todo.md` with the `run-gate.mjs` Stop hook. The run-time question is whether runs open their list before editing, keep the playbook's steps verbatim, keep the list current, and reach or explicitly skip the commit and PR gates. The cost question is whether that costs correctness, time, or money. The design and decisions are in harness-config#525. The harness work is harness-config#527.

## Arms

`build-arms.sh` builds each arm from `FORK_REV` (default `HEAD`) with `git archive`, so uncommitted edits never reach a candidate.

| Arm | List | Stop hook | Built by |
| --- | --- | --- | --- |
| `native` | `TaskCreate`/`TaskUpdate` on Claude Code, `update_plan` on Codex | none | `strip-run-gate.sh`, then `native-arm.mjs` |
| `todo` | open-run's `todo.md` | none | `strip-run-gate.sh` |
| `todo-hook` | open-run's `todo.md` | `run-gate.mjs` on both runtimes | `strip-run-gate.sh --verify`, then `codex-stop.mjs` |

`native-arm.mjs` rewrites the todolist paragraph and steps 2 to 4 of **Start the run**: the run prints the playbook's list with `open-run.mjs --dry-run`, creates one task per line with its text verbatim, and keeps a skip as a completed task carrying `skip: <reason>` in its description (Claude Code) or step text (Codex), since neither tool has a skip state. It names the tools and the `ToolSearch` query, because Claude Code defers them. Each runtime's task tool is switched on for this arm only: `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` and `-c tools.update_plan.enabled=true`.

`codex-stop.mjs` copies the Claude Code Stop entry from `hooks/hooks.json` into the arm's `hooks/codex-hooks.json`. The shipped plugin registers no Codex Stop hook. On Codex, run-gate finds the list from the rollout's `CommandExecution` items and the `Session:` line open-run stamps from `CODEX_THREAD_ID`.

Every build step checks its anchors before it writes and fails with the tree unchanged when the tree no longer matches. When a rewording breaks a build, update the anchor in the script that failed.

Native task tools with a stop gate are out of scope, as is an upstream baseline arm, which two batches already measured at 2/15 lists resolved.

## Runtimes

| Runtime | Session | Arm loaded by | Limits |
| --- | --- | --- | --- |
| `claude` | `claude -p` with stream-json | `--plugin-dir`, with an installed `pstack@pstack-claude` disabled | `RUN_MINUTES`, `BUDGET_USD` |
| `codex` | `codex exec --json`, `--sandbox workspace-write --add-dir <repo>/.git` | a Codex home per arm, which installs the arm from a local marketplace named `local` | `RUN_MINUTES` only; `codex exec` has no spend cap |

A Codex home links `auth.json` and `AGENTS.md` from `CODEX_AUTH_HOME` (default `~/.codex`), and loads no other user config. A linked `auth.json` keeps a token refresh from invalidating the original. `--add-dir <repo>/.git` is there because `workspace-write` keeps `.git` read-only; without it a candidate clones the repo elsewhere to commit, and the scored repo never changes.

The Codex homes are rebuilt per batch, so no hook in them carries persisted trust, the SessionStart hook included. `run.sh` refuses a batch with Codex runs unless you set `CODEX_HOOKS=bypass`, which passes `--dangerously-bypass-hook-trust` to every Codex run. That variable is the operator's approval of the arm's hooks.

Each runtime's candidate gets the other runtime's session id scrubbed from its environment, so a Codex batch started from a Claude Code shell cannot stamp the outer session id on a list.

## Tasks

Each task is a small Python repo under `tasks/<name>/repo` with passing visible tests, an organic prompt in `prompt.txt`, and held-out tests in `hidden/` that the candidate never sees. The held-out tests fail on the original repo and pass on a reference fix. A task may carry `reference.patch` and `task.env` beside `repo/`; `run-one.sh` copies only `repo/`. `tests/run-gate-eval-tasks.test.mjs` checks each task's tests fail on its repo, and that a `reference.patch` makes them pass.

| Task | Playbook it should route to | Held-out check |
| --- | --- | --- |
| `slugkit` | bug-fix | separators collapse and never lead or trail |
| `tally` | feature | `--json` shape, stdin as `-`, plain output unchanged |
| `confload` | refactoring | behaviour unchanged, unquoting written once |
| `logsift` | feature, or figure-it-out as an ambitious multi-part change | JSON lines, `.gz` input, `--since`/`--until`, `--min-level`, `--by`, `--format`, `logsift.toml`, `--strict`; table output unchanged |

`logsift`'s `task.env` raises its limits to 90 minutes and 30 USD.

## Running

Run from a terminal or the `!` prompt, not from a sandboxed Claude Code shell. A Claude candidate starts its own Bash sandbox and writes its transcript under `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/projects`, where `run-gate.mjs` reads it back. `run.sh` refuses to start Claude runs when it cannot write there.

Point `CLAUDE_BIN` and `CODEX_BIN` at the real binaries when a terminal wrapper shims them. The cmux shim, for one, adds its own session hooks to every `codex` it starts.

```sh
evals/run-gate/run.sh --dry-run 5                     # print the settings, every job and the ceiling; start nothing
CODEX_HOOKS=bypass evals/run-gate/run.sh --smoke      # one slugkit run per runtime and arm: 6 runs
node evals/run-gate/check-smoke.mjs                   # check the newest batch is a complete, finished smoke
CODEX_HOOKS=bypass evals/run-gate/run.sh 5            # every task x runtime x arm x 5 reps, shuffled
```

`TASKS`, `RUNTIMES` and `ARMS` restrict a batch to space-separated names, and `run.sh` rejects an unknown or repeated name before it builds anything. The dry run's ceiling is the Claude runs times `BUDGET_USD`, plus the Codex runs' total wall-clock cap, since nothing caps Codex spend.

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORK_ROOT` | `~/src/workbench` | candidate repos, per-run temp dirs (`.tmp/`) and the built arms (`.plugins/<label>`) |
| `TASKS` | every directory under `tasks/` | tasks to run |
| `RUNTIMES` | `claude codex` | runtimes to run |
| `ARMS` | `native todo todo-hook` | arms to run |
| `MODEL` | `opus` | Claude candidate model |
| `CODEX_MODEL` | the Codex default | Codex candidate model |
| `BUDGET_USD` | `10`, or the task's `task.env` | `--max-budget-usd` per Claude run |
| `RUN_MINUTES` | `45`, or the task's `task.env` | wall-clock cap per run |
| `PARALLEL` | `3` | concurrent runs |
| `CLAUDE_BIN`, `CODEX_BIN` | `claude`, `codex` | the runtime binaries |
| `CODEX_AUTH_HOME` | `~/.codex` | where a Codex home links `auth.json` and `AGENTS.md` from |
| `CODEX_HOOKS` | unset | `bypass` to run Codex arms' untrusted hooks; required for Codex runs |

An exported `BUDGET_USD` or `RUN_MINUTES` wins over a task's `task.env`.

Each run starts as `/pstack:poteto-mode <prompt>` on Claude Code, with `--strict-mcp-config`, `--permission-mode auto` and `--permission-prompts none`, and as `$pstack:poteto-mode <prompt>` on Codex. Each gets its own `TMPDIR` under `WORK_ROOT/.tmp`, removed after scoring. That does not stop a candidate from naming `/private/tmp` itself, as Codex candidates did in the smoke runs; open-run's session stamp keeps such a shared dir from handing one run another's list.

Results land in `results/<timestamp>/`, which git ignores: `arms.tsv` maps arm to label and paths, `settings.txt` holds each task's limits, and `runs/<task>-<runtime>-<arm>-<rep>/` holds the stream, the copied `todo.md` and `decisions.tsv`, Codex's `rollout.jsonl` and `children/` delegate rollouts, and `score.json`. `report.md` has a column per runtime and arm.

## Scoring

`score.mjs` reads the stream, never the candidate's own account of what it did. `score-codex.mjs` reads a Codex run's exec stream and rollout into the same shape. A list opened or an edit made by a delegate does not count for the main run, while a gate skill a delegate ran does. On Codex a skill counts as run when a command read its `SKILL.md`, since Codex has no skill tool.

- **List.** A list open-run reports counts only when its `Session:` line names the run's own session, the rule the Stop hook uses. The native list is the main thread's `TaskCreate` tasks under their last `TaskUpdate`, or its last `TodoWrite`, or Codex's last `todo_list`. A native task is open until completed, and skipped when completed with a `skip:` or `n/a:` reason in its subject, description or step text.
- **Verbatim fidelity**, every arm. The playbook's steps are the `- [ ]` lines the arm's own `open-run.mjs --dry-run` prints for the routed playbook. A step is kept when a list item holds each of its sentences in order, so a reason added between or after them still counts and a reworded or shortened sentence does not. A run that routed to no bundled playbook has no score.
- **Gates.** A gate is `done` when the run did it, `skipped` when its line carries a filled-in reason, `claimed` when it is checked off but never run, else `missing`. A native list's gates are read from its tasks the same way.
- **Outcome.** `timeout` when the cap killed the run (exit 124), `error` on any other non-zero exit or a failed or missing result, `delegate-in-flight` when the run ended with a delegate still running, else `clean`. On Claude Code a delegate is a background agent or workflow in the stream's last `background_tasks_changed` list, else a launch with no final notice; an agent waiting on its own background work counts as running, as in fork PR #2. On Codex it is a rollout whose `parent_thread_id` leads back to the run and whose last task event is a start.
- **Gate held.** `gateHeld` is whether run-gate held a stop, on the `todo-hook` arm only: a Stop hook response on Claude Code, a `HookPrompt` in the rollout on Codex.
- **Time.** Minutes are wall-clock `seconds` from `exit.json`. `duration_ms` covers only a delegating run's last main-thread stretch.

`tests/run-gate-eval-*.test.mjs` cover the stream rules, the arm builds, the runner against stub binaries, and the report.

## Delegates

Measured on Claude Code 2.1.318 and codex-cli 0.165.0, 2026-11-05:

- `claude -p` waits for a background agent: the stream shows its `task_notification`, a second `init`, and a second `result`.
- `codex exec` exits when the main turn ends and leaves a spawned agent unfinished, with no `task_complete` in its rollout.
- Codex gives the Stop hook no background-work signal, so on the `todo-hook` arm run-gate holds the first stop while a delegate runs. In the probe, the agent repeated the block message, the second stop went through, and the delegate was abandoned. Such a run scores `delegate-in-flight`.

## Blinding

Candidate-visible paths and prompts carry no eval vocabulary. Repos are named `<task>-<random>`, arms sit under random labels, the Codex marketplace is `local`, and the mapping stays in the batch directory. The eval playbook's blinded judge is left out, because every metric here is a deterministic check on the stream or the repo, and the one quality signal is the held-out tests.
