# 0023 — Measurement: eval runner, pass^k, traces and the cost ledger

- **Status:** Accepted (2026-11-19, shipped)
- **Date:** 2026-11-19
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/00-synthesis.md` principle 10 and build-order step 0 [FBK-13, OTH-07, OTH-11], `docs/research/09-other-topics.md` (observability, [OTH-07]), ADR-0011, ADR-0014

## Context
Four evals existed (`evals/compaction`, `edit-feedback`, `model-routing`, `skill-routing`). Each spawned `teh -p` its own way and reported a single pass rate, so results were not comparable across evals. Nothing measured whether a model succeeds *every* time, which is what a user who reruns a task sees. With paid providers (M1), users also needed to know what runs cost after the fact. Traces had been promised in ADR-0011 (the user's own collector, off by default) but not built.

## Decision
- **One eval runner** (`evals/lib/runner.ts`). An `EvalTask` is a fixture (files, optional setup commands run after `git init` and a first commit), a prompt, the Bash rules it may run, and a check of the folder afterwards. The runner:
  - runs every task k times per model through the real CLI in a fresh folder with its own `TEH_HOME`;
  - saves after every trial and resumes an interrupted run;
  - reads turns, usage and `total_cost_usd` from the JSON result, and model requests, tool calls and failed tool calls from the trial's trace file.
- **pass^k is the headline number** (`evals/lib/stats.ts`). It is the chance that k runs of a task all pass ([tau-bench], estimated per task as C(c,k)/C(n,k), averaged over tasks), reported beside pass@k (at least one passes). A model at pass^1 = 80% but pass^3 = 50% is not one to leave running unattended.
- **Checks must earn their passes.** Each task ships with a known-good solution in a test: the check must reject the untouched fixture and accept the solution (`evals/terminal/tasks.test.ts`).
- **A Terminal-Bench-style task set** (`evals/terminal/`): ten jobs that need only node, git and sh. They cover fixing a failing test, data wrangling (CSV, JSON, logs), git (a feature branch, a merge conflict), a shell script, a rename across files, a code question, and adding a CLI flag. It is small enough to run on a laptop with local models. It is not Terminal-Bench itself, whose Docker tasks we will run separately once the delegation work lands.
- **OpenTelemetry GenAI spans** (`packages/core/src/tracing.ts`), following the GenAI semantic conventions:
  - `invoke_agent teh` per run, with one `chat <model>` span per model request (client kind) and one `execute_tool <name>` per tool call as children;
  - attributes: `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens` / `output_tokens` / `cache_read.input_tokens`, `gen_ai.response.finish_reasons`, `gen_ai.tool.name`, `gen_ai.tool.call.id`, `error.type`, plus `teh.stop_reason`, `teh.turns`, `teh.auth_route`, `teh.permission_mode`.
  - **No content.** Prompts, replies, tool arguments, tool output and file paths are never recorded; a test checks a run's spans for its prompt and reply text.
  - **Off unless configured.** `OTEL_EXPORTER_OTLP_ENDPOINT` or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` (with `OTEL_EXPORTER_OTLP_HEADERS`) sends OTLP/HTTP JSON to the user's collector; `OTEL_SDK_DISABLED=true` wins. `TEH_TRACE_FILE` appends spans as JSON lines. Exporting happens after each run with a 5 s timeout, and a failing exporter never affects the run.
  - **No OpenTelemetry SDK dependency.** The OTLP JSON encoding is small, and the SDK would add weight to a single-binary CLI for a feature that is off by default.
- **Cost ledger** (`packages/core/src/ledger.ts`): one JSON line per run (or per prompt in the interactive UI) in `~/.teh/usage.jsonl`, holding the time, session id, the project folder's name, provider, model, auth route, tokens and cost at list prices (absent when the price is unknown). `teh usage [--days n]` sums it by day and by model. It stays on the user's machine and is unrelated to ADR-0011's statistics.

## Consequences
- New evals use the shared runner; the four older ones keep their own scripts until they are next touched.
- pass^k needs at least k trials per task; the default is 3.
- The ledger grows by one short line per run (about 300 bytes); there is no rotation yet.
- Traces are per run. The interactive UI flushes after each prompt, so a session is several traces sharing `gen_ai.conversation.id` when a session log exists.
- **Revisit when** the GenAI semantic conventions leave "development" status (attribute names may change), or when evals need graded rather than pass/fail checks.

[tau-bench]: https://arxiv.org/abs/2406.12045
