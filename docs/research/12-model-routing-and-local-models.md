# 12 — Model routing and local models

Two linked requirements, added 2026-11-03:
1. **Routing:** a decision model picks the provider and model per task. Easy work goes to cheap, fast models and hard work to strong ones, to cut tokens and cost.
2. **Local models:** users can connect any locally deployed model (Ollama, LM Studio, llama.cpp, vLLM and so on).

It also answers a related question: **do instruction files such as `CLAUDE.md` need updating when you switch providers?** (§6).

## 1. What the evidence says about routing

**Routing can pay, in principle.** RouteLLM [LLM-08] and FrugalGPT [LLM-09] report large cost cuts at similar quality on benchmarks. The per-task "oracle" (always picking the cheapest model that would have succeeded) is far cheaper than always using the strongest model [RTE-02, RTE-04].

**In practice, routers rarely capture that gain.** Treat this as the main design constraint:
- **LLMRouterBench** (400K+ instances, 33 models, 10 routing methods): several recent approaches, including commercial routers, "fail to reliably outperform a simple baseline". Most methods perform about the same, and a large gap to the oracle remains [RTE-03].
- **AutoBench Router Benchmark** (Oct 2026; vendor-run, single study, so directional): no commercial router beat "always call one mid-priced model" on quality and cost together. Several were close to "a knob in front of a constant", sending ≥90% of prompts to one model. A FrugalGPT-style cascade scored below random [RTE-04].
- **Agent-as-a-Router** (coding tasks): the best model varies by task, and always picking the strongest model trails the per-task oracle. Even a strong LLM used as a few-shot router falls well short. The authors trace this to an **information deficit**, not weak reasoning. Feeding the router task-type performance statistics gave a 15.3% relative gain, and learning from execution results during deployment did best [RTE-02].
- **Agentic routing is under-studied.** Most benchmarks score single prompts, not multi-step agent sessions [RTE-16, RTE-05].

**Coding agents use role-based routing, not per-prompt routers.** Claude Code:
- assigns models to roles, for example `opusplan` (Opus while planning, Sonnet while executing) and `haiku` "for simple tasks";
- sets a per-subagent model and a reasoning-effort level;
- falls back to another model when the primary is overloaded, for one turn only [RTE-01].

OpenRouter's Auto Router classifies each prompt into about 30 task types and picks the model the market spends most on for that type, within a cost tier [RTE-07].

### Agent-specific costs of switching models
These costs are why per-turn routing inside a coding session can cost more than it saves:
- **Prompt caching is per model and per prefix.** Cached input is billed at a fraction of the normal price [PERF-01]. A long session is mostly cached prefix, so switching model or provider mid-session re-pays the whole prefix at full price. Changing tools or thinking settings also invalidates the cache [PERF-01].
- **Reasoning state does not transfer.** Reasoning items from one provider cannot be replayed to another (doc 02).
- **Behaviour shifts mid-task.** A different model may not follow the plan or edit style the first one started.

## 2. Recommended routing design ("model policy")
The router is a layered **model policy** in the engine, between the agent loop and the provider layer. It makes decisions **at task boundaries**, never mid-turn.

| Layer | What decides | When | Notes |
|---|---|---|---|
| **1. Roles** (v1) | Config maps roles to models: `main`, `plan`, `fast` (titles, summaries, commit messages, classification), `explore` (read-only subagents), `compact`, `judge` | Fixed per role | Deterministic. Mirrors Claude Code's aliases and subagent models (ADR-0010) [RTE-01] |
| **2. Task triage** (v1) | A cheap classifier assigns a new task or subagent a tier: **S / M / L** | At the start of a task or subagent | Rules first (prompt size, files and lines in scope, keywords such as "refactor" or "architecture", plan mode, repo size). Optional small model, possibly local [RTE-06] |
| **3. Escalation** (v1) | Move up a tier, at the next task boundary | When verification fails: tests fail, the evaluator rejects, tool-call errors repeat, the model gives up | Escalate only; never downgrade mid-task. **Asks first** (decided 2026-11-03): the prompt shows the current and proposed model and the reason. The cap and budget come from config |
| **4. Effort** (v1) | Raise reasoning effort on the same model before switching model | Same triggers as escalation, tried first | Keeps the same provider and conversation. Changing thinking settings still invalidates part of the cache [PERF-01] |
| **5. Learned policy** (later) | Per-task-type success and cost statistics from our own evals and (opt-in) usage | Replaces or tunes the triage rules | Addresses the "information deficit" [RTE-02]; needs data from phases 0 and 8 |

Rules that follow from the evidence:
1. **Ship with a strong default and routing off**, until our eval suite shows a routing policy beats "always use one mid-tier model" on pass rate per dollar [RTE-03, RTE-04]. Routing then becomes the default for the presets where it wins.
2. **Route at boundaries:** session start, plan→execute, subagent spawn, compaction, background jobs. Never per turn inside a task, because of the cache, reasoning and behaviour costs in §1.
3. **The cost model knows the auth route** (ADR-0009):
   - API keys cost per token.
   - A ChatGPT plan costs nothing per token but has usage limits.
   - A local model costs nothing per token but is slower and smaller.
   - A delegated Claude Code run uses the user's Claude plan.

   "Cheapest" means cheapest for this user.
4. **Visible and overridable:** the status line shows the model and why it was chosen (`fast · triage: S`). `/model` pins a model for the session, and a pin always wins. Under ADR-0008 the user already sees every action, so a surprise model switch would break trust.
5. **Hard capability filters before cost:**
   - the model must support tool calling, the context needed, and any images or files in the task;
   - a model that fails these is never routed to, however cheap.

## 3. Local models: what the platforms expose

| Runtime | APIs | Tool calling | Context window | Notes |
|---|---|---|---|---|
| **Ollama** | Native `/api/chat`; OpenAI-compatible; Anthropic-compatible (Messages, streaming, tools, thinking, images) | Yes, for models that support it | **Defaults by VRAM: 4k under 24 GiB, 32k at 24–48 GiB, 256k at 48 GiB or more.** Ollama recommends **at least 64k for agents and coding tools** [RTE-08] | The Anthropic-compatible API lacks prompt caching, `tool_choice` and token counting [RTE-09]. Reports say the OpenAI-compatible path can silently ignore `num_ctx` and truncate at 4k [RTE-10]. Use the native API and set `num_ctx` |
| **LM Studio** | OpenAI-compatible (`/v1/chat/completions`, `/v1/responses`); Anthropic-compatible since 0.4.1 | On the OpenAI and Anthropic endpoints | Set per model in the app | Default `localhost:1234` [RTE-11] |
| **llama.cpp** (`llama-server`) | OpenAI-compatible | With `--jinja`. Native formats for Llama 3.x, Qwen 2.5, Hermes, Mistral Nemo, GPT-OSS and others; a less efficient generic fallback for the rest. Parallel calls are off by default | `-c` flag | [RTE-12] |
| **vLLM** | OpenAI-compatible | Yes (model-dependent) | Server config | For self-hosted GPUs [LLM-10] |

What this means for an agent harness:
- **Small context is the main failure mode.** A coding agent's first request (system prompt, tool schemas, instruction files) can exceed a 4k or 32k default. Ollama then truncates silently instead of erroring [RTE-08, RTE-10]. The harness must know each model's **actual** window and act on it.
- **Tool-calling quality varies widely** among small open models. The BFCL leaderboard weights agentic and multi-turn tool use most heavily and is the standard reference for picking local models for agent work [RTE-14]. Harness × model matters as much as model alone [CMP-17].
- **No prompt caching on most local runtimes** [RTE-09]. A long static prefix is re-processed every turn, so keep prompts lean for local models.

## 4. Requirements for local models
1. **Adapters:**
   - a **generic OpenAI-compatible adapter** (LM Studio, llama.cpp, vLLM, and any OpenAI-style gateway);
   - a **native Ollama adapter** that sets `num_ctx`, lists and pulls models, and reads model info and loaded context (`/api/show`, `ollama ps`) [RTE-08].
2. **Discovery:** `teh models` and first-run setup probe the default local ports (Ollama `11434`, LM Studio `1234`, llama.cpp `8080`) and list what is running. Users can also add any base URL.
3. **Capability registry:**
   - static data from **models.dev**, an open-source database of context limits, prices and capability flags (tool calling, reasoning, attachments, structured output, open weights) that OpenCode also uses [RTE-13];
   - user overrides in settings;
   - a **live probe** on first use: one tiny tool call, plus the real context window from the runtime.

   Probe results are cached per model.
4. **Context-aware engine:**
   - compaction thresholds, tool-result clearing and the instruction-file budget scale to the model's real window;
   - a refusal with a clear fix (for example "set `OLLAMA_CONTEXT_LENGTH=65536`") when the window is too small to run at all.
5. **Lean prompt profile for small models:** fewer tools loaded at once (tool search, doc 06), a shorter system prompt, and an edit format the model handles well (doc 10 §3).
6. **Fallback tool calling:** for models without native tool calls, a prompted JSON tool-call format that is parsed and validated, clearly marked as lower reliability.
7. **Local-only mode** (`--local-only` or a setting): network egress is limited to localhost model endpoints, and cloud providers and web tools are disabled. In this mode telemetry is **off** too, because a user who chose local-only expects no network traffic at all. Decided 2026-11-03 and recorded in ADR-0011.
8. **Timeouts and streaming tuned for slow hardware:** long first-token waits, a visible "loading model" state, and cancellation that actually stops generation.

## 5. How this changes the direction
| Area | Before | Now |
|---|---|---|
| Provider layer (ADR-0002) | Native Anthropic + OpenAI adapters, generic adapter "for the long tail" | **The generic OpenAI-compatible adapter and the native Ollama adapter move into the first release.** A capability registry and a cost model per auth route become part of the layer |
| New engine component | — | **Model policy (router):** roles + triage + escalation + effort in v1, learned policy later. New ADR-0014 |
| Context engine (phase 3) | Sized for large cloud windows | **Model-aware:** budgets and compaction from each model's real window, from 4k to 1M |
| Evals (phase 0) | Measure the harness | **Also the gate for routing:** a policy ships as default only if it beats a single mid-tier model on pass rate per dollar |
| Telemetry (ADR-0011) | Model id, feature use | Adds routing tier, escalation count, auth route, and local vs cloud. Local-only mode turns telemetry off |
| Development cost | Paid API keys needed to try the agent | **Ollama with a free local model lets you build and try `teh` without paying.** The first working agent should run against Ollama as well as the cloud providers |
| Product brief | — | New requirements: cost-aware routing, any local model, local-only mode |

## 6. Do instruction files need updating per provider?
**No.** Instruction files are plain Markdown, and the harness reads them and puts them into **whatever model's** prompt. The model never reads the file itself. Write the facts once, and every provider sees the same text.

How `teh` handles it:
- **One canonical file:** `AGENTS.md`, the cross-tool convention read by Codex, Cursor, Gemini CLI (via config) and others [SKL-07]. Claude Code reads `AGENTS.md` when there is no `CLAUDE.md`. Teams that also use Claude Code can keep a `CLAUDE.md` that just says `@AGENTS.md`: Claude Code expands imports up to four hops deep [RTE-15]. `teh` reads both and resolves the same imports (ADR-0010).
- **Learned memory lives in `teh`'s own memory store**, not in `CLAUDE.md`. It is injected for every provider, so nothing needs copying when you switch.
- **Per-model differences belong to the harness, not your files.** What changes between models is *how* to prompt, not the project facts:
  - system-prompt wording;
  - edit format;
  - tool-description style;
  - how much fits in context.

  `teh` keeps a **prompt profile per model family**, so users never maintain model-specific copies.
- **The one real constraint is size.** A 4k–32k local model may not fit long instruction files. The harness budgets them:
  - always load the root file;
  - load path-scoped rules only when you touch those paths;
  - summarise or trim when over budget, and say so.
- **Switching provider mid-session keeps the conversation**, because it is stored in our provider-neutral format (doc 02). It loses the prompt cache and any provider-specific reasoning state (§1). That is why the model policy switches only at boundaries.

## Open questions
- Which features drive triage best for coding tasks? Start with rules and measure, then consider a small learned classifier (Arch-Router-style [RTE-06]).
- Should `teh` bundle or recommend specific local models? Proposed: recommend by BFCL score and probe results, and never bundle weights.

<!-- SOURCES:RTE -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| RTE-01 | [Claude Code model configuration (aliases, opusplan, subagent models, effort, fallback)](https://code.claude.com/docs/en/model-config) | Anthropic | 2026 | Must read |
| RTE-02 | [Agent-as-a-Router: Agentic Model Routing for Coding Tasks](https://arxiv.org/abs/2606.22902) | Zhou et al. | 2026-06 | Must read |
| RTE-03 | [LLMRouterBench: A Massive Benchmark and Unified Framework for LLM Routing](https://arxiv.org/abs/2601.07206) | Li et al. | 2026-01 | Must read |
| RTE-04 | [AutoBench Router Benchmark: Do LLM Routers Pay for Themselves?](https://huggingface.co/blog/PeterKruger/router-benchmark-2026-10) | AutoBench (P. Kruger) | 2026-10 | Should read |
| RTE-05 | [RouterBench: A Benchmark for Multi-LLM Routing System](https://arxiv.org/abs/2403.12031) | Hu et al. (Martian) | 2024-03 | Optional |
| RTE-06 | [Arch-Router: Aligning LLM Routing with Human Preferences](https://arxiv.org/abs/2506.16655) | Tran, Paracha et al. (Katanemo) | 2025-06 | Optional |
| RTE-07 | [OpenRouter Auto Router](https://openrouter.ai/docs/guides/routing/routers/auto-router) | OpenRouter | 2026 | Should read |
| RTE-08 | [Ollama context length](https://docs.ollama.com/context-length) | Ollama | 2026 | Must read |
| RTE-09 | [Ollama Anthropic API compatibility](https://docs.ollama.com/api/anthropic-compatibility) | Ollama | 2026 | Should read |
| RTE-10 | [Why Ollama tool calls fail at a 4,096 context length](https://dev.to/orca_forge/why-ollama-tool-calls-fail-at-a-4096-context-length-pe9) | DEV Community | 2026 | Optional |
| RTE-11 | [LM Studio OpenAI-compatible API](https://lmstudio.ai/docs/api/openai-api) | LM Studio | 2026 | Should read |
| RTE-12 | [llama.cpp function calling](https://github.com/ggml-org/llama.cpp/blob/master/docs/function-calling.md) | ggml-org | 2026 | Should read |
| RTE-13 | [models.dev: open database of AI model specs and pricing](https://github.com/anomalyco/models.dev) | Anomaly (OpenCode) | 2026 | Must read |
| RTE-14 | [Berkeley Function Calling Leaderboard (BFCL v4)](https://gorilla.cs.berkeley.edu/leaderboard.html) | UC Berkeley (Gorilla) | 2025-12 | Should read |
| RTE-15 | [Claude Code memory: CLAUDE.md, AGENTS.md and imports](https://code.claude.com/docs/en/memory) | Anthropic | 2026 | Must read |
| RTE-16 | [TwinRouterBench: Static and Live Evaluation for Realistic Agentic LLM Routing](https://arxiv.org/abs/2605.18859) | arXiv preprint | 2026-05 | Optional |
<!-- /SOURCES -->
