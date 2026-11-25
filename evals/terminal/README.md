# Terminal eval

Can a model finish small terminal jobs through teh, and does it finish them every time? This is a Terminal-Bench-style eval: each task is a folder with a request, and a check that inspects the folder afterwards (files, program output, git state), never the model's words alone. Every run goes through the real CLI (`teh -p`) in a fresh folder with its own `TEH_HOME`. Only node, git and sh are needed. It is not Terminal-Bench itself; the Docker tasks come later, with the delegation work (ADR-0023).

## Setup
- **Tasks:** ten jobs, defined in [`tasks.ts`](tasks.ts):
  - `fix-failing-test`: fix the bug in the library, not the test, so `node test.js` passes.
  - `csv-summary`: write `summary.json` with the total amount per region from `sales.csv`.
  - `git-feature-branch`: create `feature/greet` with a `greet.js` commit and a clean tree.
  - `find-port`: say which port the server listens on when `PORT` is unset, across a config module.
  - `rename-function`: rename `getUsr` to `getUser` in every file and check `node main.js` still works.
  - `log-error-codes`: list the distinct error codes on ERROR lines of `server.log`, sorted, in `errors.txt`.
  - `shell-script`: write an executable POSIX sh script that counts `.txt` files recursively.
  - `json-to-csv`: convert `users.json` to `users.csv`, sorted by id.
  - `merge-conflict`: resolve an in-progress merge of `retries` into `main` and finish it with a commit.
  - `add-cli-flag`: add an `--upper` flag to `cli.js` without changing the default output.
- **Grading:** each task's `check` runs against the folder after the model stops. Each task ships with a known-good solution in [`tasks.test.ts`](tasks.test.ts): the check must reject the untouched fixture and accept the solution.
- **Machine:** local models through Ollama. Cost is `$0.00` because the models run locally.

## Run it
Needs [Ollama](https://ollama.com) running with both models pulled.

```bash
bun evals/terminal/run.ts --models ollama:gemma4:e4b,ollama:qwen2.5:14b --trials 3 --out local-2026-11-19 --timeout 240
```

- `--trials 3` runs each task three times per model. `--timeout` is in seconds per run; a run over the limit is killed and counts as a fail.
- Results are saved to `results/<out>.json` after every trial. A run that is interrupted resumes where it stopped and skips finished trials.
- `--tasks fix,csv` runs only tasks whose id starts with one of the prefixes.

## Metrics
- **pass@k**: the chance that at least one of k runs of a task passes. It answers "can this model do it at all?".
- **pass^k**: the chance that all k runs of a task pass, averaged over tasks (estimated per task as C(c,k)/C(n,k), where c passes in n runs). It answers "will it do it every time?", which is what someone who reruns a task sees. A model can be strong at pass@k and weak at pass^k. pass^k is the headline number (ADR-0023).
- **pass^1** is the plain pass rate per run. **med s** is the median run time; **turns** and **tool err** are the mean model turns and the share of tool calls that failed.

## Results (2026-11-25)
Run started 2026-11-19 and finished 2026-11-25, 60 runs (10 tasks x 2 models x 3 trials), in [`results/local-2026-11-19.json`](results/local-2026-11-19.json).

```
model                             pass^1  pass^3  pass@3  med s  turns  tool err   cost
ollama:gemma4:e4b                    70%     50%     80%   32.1    6.6       21%  $0.00
ollama:qwen2.5:14b                   47%     30%     60%   39.8    3.8       25%  $0.00
```

Per task (passes out of 3):

```
task                     ollama:gemma4:e4b ollama:qwen2.5:14b
fix-failing-test                    3/3            3/3
csv-summary                         0/3            3/3
git-feature-branch                  3/3            0/3
find-port                           3/3            2/3
rename-function                     3/3            3/3
log-error-codes                     2/3            0/3
shell-script                        0/3            0/3
json-to-csv                         2/3            0/3
merge-conflict                      3/3            1/3
add-cli-flag                        2/3            2/3
```

## Observations
- Neither model passed `shell-script` in any of its three runs, so that task is the clearest gap. `fix-failing-test` and `rename-function` were solved every time by both.
- The two models fail on different tasks: gemma4:e4b missed `csv-summary` three times while qwen2.5:14b passed it every time, and qwen2.5:14b missed `git-feature-branch` and `json-to-csv` three times each.
- gemma4:e4b is ahead on pass^3 (50% against 30%) and has the faster median run (32.1 s against 39.8 s), so it is the stronger choice for repeated runs on this task set.
- Three trials per task is a small sample: a difference of one pass in a task is noise.
