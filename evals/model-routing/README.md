# Model-routing eval

Does choosing a model per task beat always using one? ADR-0014 makes that the gate for routing: a routing policy must beat the best single model on pass rate per unit of cost, losing no more than 2 points of pass rate.

## Setup
- **Project:** a small JavaScript project (`tasks.ts`) with a README, three modules, a CLI and a failing test.
- **Tasks:** eight jobs. The tier is what teh's rule-based triage assigns to the prompt:

  | Task | Tier | Asks for |
  |---|---|---|
  | S1-question | S | what `slugify("Hello World")` returns |
  | S2-typo | S | fix "recieve" in the README |
  | S3-rename | S | rename a variable |
  | M1-add-function | M | add and export `isEven` |
  | M2-fix-test | M | fix the bug that fails `bun test`, without editing the test |
  | M3-cli-flag | M | add a `--verbose` flag |
  | L1-implement | L | write `parseDuration("1h30m")` and friends |
  | L2-debug | L | make `average([])` return 0 and reject non-numbers |

- **Grading:** each task is checked from the files and reply the run leaves behind, by running the code.
- **How each run goes:** through the real CLI, `teh -p --permission-mode acceptEdits`, allowing `bun test`, `bun cli.js`, `bun run` and `node`. A run that takes over 300 s is killed and counts as a fail.
- **Machine:** MacBook, 24 GiB RAM, Ollama. "Cost" is wall time and tokens, since local models cost no money.
- **Choices compared:**
  - **always one model**, for each of the three models;
  - **auto by size**: the rule teh shipped first, where S takes the smallest model, M the middle one and L the largest;
  - **auto by measured score**: the fastest model whose pass rate on that tier is within 2 points of the best. Each task is scored with a choice made from the *other* tasks' runs, so no task is graded with a choice its own runs informed.

Because the automatic choice depends only on the prompt and the installed models, its outcome on a task is the outcome of the model it picks. The report reads it from the same runs instead of running again.

```bash
bun evals/model-routing/run.ts --models ollama:mistral-nemo:12b,ollama:qwen2.5:14b,ollama:gemma4:e4b --runs 3 --out routing-2026-11-11 [--save-scores]
```

`--save-scores` writes the per-tier pass rates and times to `~/.teh/model-scores.json`. From then on, teh chooses models from those scores instead of the built-in ones.

## Results (2026-11-11)
72 runs, 3 per task per model, in [`results/routing-2026-11-11.json`](results/routing-2026-11-11.json):

| Choice | Pass rate | Mean s/run | Mean tokens/run | Passes per hour |
|---|---|---|---|---|
| mistral-nemo:12b always | 8% (2/24) | 13 | 6,248 | 23 |
| qwen2.5:14b always | 75% (18/24) | 68 | 13,215 | 40 |
| **gemma4:e4b always** | **96% (23/24)** | **24** | 8,399 | **141** |
| auto by size | 58% (14/24) | 41 | 11,898 | 51 |
| **auto by measured score** | **96% (23/24)** | **24** | 8,399 | **141** |

Per task (passes out of 3):

| Task | mistral-nemo:12b | qwen2.5:14b | gemma4:e4b | By size picks | By score picks |
|---|---|---|---|---|---|
| S1-question | 2 | 1 | 3 | mistral-nemo | gemma4 |
| S2-typo | 0 | 3 | 3 | mistral-nemo | gemma4 |
| S3-rename | 0 | 3 | 3 | mistral-nemo | gemma4 |
| M1-add-function | 0 | 3 | 3 | qwen2.5 | gemma4 |
| M2-fix-test | 0 | 2 | 2 | qwen2.5 | gemma4 |
| M3-cli-flag | 0 | 1 | 3 | qwen2.5 | gemma4 |
| L1-implement | 0 | 3 | 3 | gemma4 | gemma4 |
| L2-debug | 0 | 2 | 3 | gemma4 | gemma4 |

## Findings
1. **Size on disk is not capability.** gemma4:e4b is the largest download (9.6 GB, because it carries vision and audio weights), but it is a small model with an effective 4B parameters. It was also the most accurate and the second fastest. mistral-nemo:12b is 12B but passed 2 of 24.
2. **Choosing by size lost 38 points against the best single model** (58% against 96%), and took 70% longer per run. It sent every small task to the model that failed most. Those numbers are the reason teh no longer chooses this way.
3. **Choosing by measured score matched the best single model**, because on this machine one model is both the most accurate and among the fastest at every tier. Routing found that model but had nothing to route around. That meets the ADR-0014 gate (no loss in pass rate, no extra cost) without beating it.
4. **Routing would only pay with a model that is good enough on easy tasks and much cheaper than the best.** Neither of the other two models is: mistral-nemo fails even the small tasks, and qwen2.5 is slower than gemma4.
5. **How mistral-nemo failed:** almost every run ended after two turns, with no file changed and a reply that described the change. This was not investigated further. It is the same pattern of claiming success that the edit-feedback eval found.

## Limits
- Eight tasks, three models, one machine and three runs each. A difference of one or two passes is noise.
- **The tiers come from teh's own triage rules,** so the eval measures that triage together with the models. It does not test whether a different S/M/L split would route better.
- **Grading is by the result,** not by how the result was reached. A run that passed after a destructive detour still passes.
- **One run was killed at 300 s** (qwen2.5, S1) and counts as a fail.
- **Only the first `--allowedTools` rule applied** (found 2026-11-11, fixed in PR #29). The CLI took one value per `--allowedTools`, so the runner's other rules (`bun cli.js`, `bun run`, `node`) were not allowed, and they were added to the front of every task prompt as text. Every model got the same handicap, so the comparison holds, but absolute pass rates on tasks that needed those commands are likely low. The eval should be rerun.
- **An earlier attempt was discarded.** Its runner did not drain the child's stderr, and 16 qwen2.5 runs died after about 30 s for that reason, not because of the model. All qwen2.5 runs were redone after the runner was fixed. mistral-nemo and gemma4 runs from that attempt were kept: none of them were killed.
