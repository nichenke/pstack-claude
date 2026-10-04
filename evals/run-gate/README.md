# run-gate eval

Measures whether the 0.9.68 fork changes what a poteto-mode run does. The fork adds `open-run.mjs`, **Start the run**, **Precedence**, and the `run-gate.mjs` Stop hook. The run-time question is whether runs open their todolist before editing, keep it current, and reach or explicitly skip the commit and PR gates. The cost question is whether that costs correctness, turns, or money.

## Arms

`build-arms.sh` builds each arm from git, so uncommitted edits never reach a candidate.

| Arm | Source | What it isolates |
| --- | --- | --- |
| `upstream` | `UPSTREAM_REV`, default `origin/main` | the unforked port |
| `prose` | `FORK_REV`, default `HEAD`, minus the Stop hook and the sentence that names it | the skill text and `open-run.mjs` alone |
| `hook` | `FORK_REV` as is | the full fork |

## Tasks

Each task is a small Python repo under `tasks/<name>/repo` with passing visible tests, an organic prompt in `prompt.txt`, and held-out tests in `hidden/` that the candidate never sees. The held-out tests fail on the original repo and pass on a reference fix.

| Task | Playbook it should route to | Held-out check |
| --- | --- | --- |
| `slugkit` | bug-fix | separators collapse and never lead or trail |
| `tally` | feature | `--json` shape, stdin as `-`, plain output unchanged |
| `confload` | refactoring | behaviour unchanged, unquoting written once |

## Running

Run from a terminal or the `!` prompt, not from a sandboxed Claude Code shell. A candidate starts its own Bash sandbox and writes its transcript under `~/.claude/projects`, where `run-gate.mjs` reads it back. `run.sh` refuses to start when it cannot write there.

```sh
evals/run-gate/run.sh --smoke   # one hook-arm run of slugkit
evals/run-gate/run.sh           # 3 tasks x 3 arms x 5 reps = 45 runs, shuffled
```

| Variable | Default | Meaning |
| --- | --- | --- |
| `WORK_ROOT` | `~/src/workbench` | candidate repos and the built arms (`.plugins/<label>`) |
| `MODEL` | `opus` | candidate model |
| `BUDGET_USD` | `10` | `--max-budget-usd` per run |
| `RUN_MINUTES` | `45` | wall-clock cap per run |
| `PARALLEL` | `3` | concurrent runs |

Each run starts as `/pstack:poteto-mode <prompt>` with `--strict-mcp-config`, `--permission-mode auto`, and `--permission-prompts none`, and with an installed `pstack@pstack-claude` disabled so only the arm loads. The user's own settings, rules, and other plugins load as they would in a real session, and the same for every arm.

Results land in `results/<timestamp>/`, which git ignores: `arms.tsv` maps arm to label, and `runs/<task>-<arm>-<rep>/` holds the stream, the copied `todo.md` and `decisions.tsv`, and `score.json`. `report.md` is the per-arm table.

## Scoring

`score.mjs` reads the stream-json, never the candidate's own account of what it did. A list opened or an edit made by a subagent does not count for the main run, while a gate skill a subagent ran does. A gate counts as `skipped` only when its `todo.md` line carries a filled-in `skip:` or `n/a:` reason, as `open-run.mjs --check` requires, and as `claimed` when the line is checked off but the run never invoked it. `tests/run-gate-eval-score.test.mjs` covers the stream rules.

## Blinding

Candidate-visible paths and prompts carry no eval vocabulary. Repos are named `<task>-<random>`, arms sit under random labels, and the mapping stays in the batch directory. The eval playbook's blinded judge is left out, because every metric here is a deterministic check on the stream or the repo, and the one quality signal is the held-out tests.
