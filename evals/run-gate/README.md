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

`codex-stop.mjs` copies the Claude Code Stop entry from `hooks/hooks.json` into the arm's `hooks/codex-hooks.json`, since the shipped plugin registers no Codex Stop hook. How run-gate reads a Codex run is in the header of `plugins/pstack/hooks/run-gate.mjs`.

Every build step checks its anchors before it writes and fails with the tree unchanged when the tree no longer matches. `strip-run-gate.sh` also fails after the strip if any mention of the hook survives. When a rewording breaks a build, update the anchor in the script that failed.

Native task tools with a stop gate are out of scope, as is an upstream baseline arm, which two batches already measured at 2/15 lists resolved.

## Runtimes

| Runtime | Session | Arm loaded by | Limits |
| --- | --- | --- | --- |
| `claude` | `claude -p` with stream-json | `--plugin-dir`, with an installed `pstack@pstack-claude` disabled | `RUN_MINUTES`, `BUDGET_USD` |
| `codex` | `codex exec --json`, `--sandbox workspace-write --add-dir <repo>/.git` | a Codex home per arm, which installs the arm from a local marketplace named `local` | `RUN_MINUTES` only; `codex exec` has no spend cap |

A Codex home links `auth.json` and `AGENTS.md` from `CODEX_AUTH_HOME` (default `~/.codex`), and loads no other user config. `run-one.sh` says why Codex runs need `--add-dir <repo>/.git`.

The Codex homes are rebuilt per batch, so no hook in them carries persisted trust, the SessionStart hook included. `run.sh` refuses a batch with Codex runs unless you set `CODEX_HOOKS=bypass`, which passes `--dangerously-bypass-hook-trust` to every Codex run. That variable is the operator's approval of the arm's hooks.

Each runtime's candidate gets the other runtime's session id scrubbed from its environment, so a Codex batch started from a Claude Code shell does not stamp the outer session id on a list beside its own.

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
node evals/run-gate/check-smoke.mjs                   # check the newest batch has one run per runtime and arm that exited 0 with a result
CODEX_HOOKS=bypass evals/run-gate/run.sh 5            # every task x runtime x arm x 5 reps, shuffled
```

`TASKS`, `RUNTIMES` and `ARMS` restrict a batch to space-separated names, and `run.sh` rejects an unknown or repeated name before it builds anything. The dry run prints a USD ceiling, the sum of each Claude run's budget, and separately the Codex runs' total wall-clock cap, since nothing caps Codex spend.

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

Each run starts as `/pstack:poteto-mode <prompt>` on Claude Code, with `--strict-mcp-config`, `--permission-mode auto` and `--permission-prompts none`, and as `$pstack:poteto-mode <prompt>` on Codex. Each gets its own `TMPDIR` under `WORK_ROOT/.tmp`, removed after scoring. That does not stop a candidate from naming `/private/tmp` itself, as Codex candidates did in the smoke runs. open-run's session stamp keeps such a shared dir from handing one run another's list, but a `decisions.tsv` carries no stamp, so two concurrent native-arm runs that pick the same path can be scored on one trail.

Results land in `results/<timestamp>/`, which git ignores: `arms.tsv` maps arm to label and paths, `settings.txt` holds each task's limits, `jobs.txt` the jobs, `errors.log` each job's runner diagnostics, and `runs/<task>-<runtime>-<arm>-<rep>/` holds the stream, the copied `todo.md` and `decisions.tsv`, Codex's `rollout.jsonl` and `children/` delegate rollouts, and `score.json`. `report.md` has a column per runtime and arm. It opens by naming every job in `jobs.txt` with no `score.json`, since each rate counts scored runs only, and every run scored by an older `SCORER` than `score.mjs` carries; `report.mjs` then exits 1, and so does `run.sh`.

## Scoring

`score.mjs` reads the stream, never the candidate's own account of what it did. `score-codex.mjs` reads a Codex run's exec stream and rollouts into the same shape; its docstring says what each source supplies. A list opened or an edit made by a delegate does not count for the main run, while a gate skill or command a delegate ran does, on both runtimes.

- **List.** A list open-run reports counts only when its `Session:` line names the run's own session, the rule the Stop hook uses. The native list is the main thread's `TaskCreate` tasks under their last `TaskUpdate`, merged with its last `TodoWrite`, or Codex's last `todo_list`. A native task is open until completed, and skipped when completed with a `skip:`, `n/a:` or `BLOCKED:` reason in its subject, description or step text.
- **Verbatim fidelity**, every arm. The playbook's steps are the `- [ ]` lines the arm's own `open-run.mjs --dry-run` prints for the routed playbook, matched against list items by `fidelity` in `score.mjs`. A run that routed to no bundled playbook has no score.
- **Gates.** A gate is `done` when the run invoked it (a Skill call, a Codex command that read its `SKILL.md` and exited 0, or a `gh pr create`, which fails in these remote-less repos, so PR `done` means attempted), `skipped` when its line carries a filled-in reason, `claimed` when it is checked off but never run, else `missing`. A native list's gates are read from its tasks the same way.
- **Outcome.** `timeout` when the cap killed the run (exit 124), `error` on any other non-zero exit or a failed or missing result, `unknown` when a Codex run's rollouts could not settle whether a delegate was still running, `delegate-in-flight` when one was, else `clean`. Which delegates count as running is in the `scoreStream` and `scoreCodex` docstrings.
- **Delegates.** On Claude Code, background agents and workflows only, since a foreground agent blocks the main turn; on Codex, the main thread's `spawn_agent` calls, which never block.
- **Plugin loaded.** On Claude Code the `init` event's plugin path; on Codex the plugin root of the first command that read poteto-mode's files, which is null for a run that never did.
- **Gate held.** `gateHeld` is whether run-gate held a stop, on the `todo-hook` arm only: a Stop hook response on Claude Code, a `HookPrompt` in the rollout on Codex. It is null when there is no evidence either way: no Stop hook response at all, a Stop hook that errored, or no rollout. Codex records only a held stop, not one let through.
- **Time.** Minutes are wall-clock `seconds` from `exit.json`, for the reason `report.mjs` gives.

`tests/run-gate-eval-*.test.mjs` cover the stream rules, the arm builds, the runner against stub binaries, and the report.

## Delegates

Measured on Claude Code 2.1.318 and codex-cli 0.165.0, 2026-11-05:

- `claude -p` waits for a background agent: the stream shows its `task_notification`, a second `init`, and a second `result`.
- `codex exec` exits when the main turn ends and leaves a spawned agent unfinished, with no `task_complete` in its rollout.
- On the `todo-hook` arm, run-gate held the first stop while a delegate ran. The agent repeated the block message, the second stop went through, and the delegate was abandoned. Such a run scores `delegate-in-flight`.

## Blinding

Candidate-visible paths and prompts carry no eval vocabulary. Repos are named `<task>-<random>`, arms sit under random labels, the Codex marketplace is `local`, and the mapping stays in the batch directory. The eval playbook's blinded judge is left out, because every metric here is a deterministic check on the stream or the repo, and the one quality signal is the held-out tests.
