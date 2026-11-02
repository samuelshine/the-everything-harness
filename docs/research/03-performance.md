# 03 — Optimisation: run faster (and cheaper)

## Where the time and money go in an agent
1. **Prefill of long contexts.** Input:output is about 100:1 in agent loops [CTX-04]. Fix with caching and smaller contexts.
2. **Sequential round trips.** Each tool call is a model turn. Fix with parallel tool calls, batching work into code, and fewer, higher-level tools.
3. **Slow tools.** Builds, tests and web fetches. Fix with concurrency, timeouts, background execution and incremental runs.
4. **Over-thinking.** Fix with reasoning-effort controls per task [PRM-10].
5. **Multi-agent overhead.** About 15x tokens vs chat [AGT-02]. Use it only where parallelism pays.

## Techniques, ranked by leverage for a harness (not an inference server)
| Technique | Effect | Harness action | Sources |
|-----------|--------|----------------|---------|
| **Prompt caching** | Cached reads at a fraction of input price, plus lower time to first token | Cache-stable layout, explicit breakpoints (Anthropic), `prompt_cache_key` (OpenAI); track hit rate | PERF-01, PERF-02, PERF-03, CTX-04 |
| **Context minimisation** | Fewer tokens to prefill, better accuracy | Ch. 01 techniques; tool-result clearing; deferred tool loading | CTX-01, CTX-02, MCP-04 |
| **Parallel tool execution** | Wall-clock reduction for independent calls | Let the model emit parallel calls and execute them concurrently; DAG planning for complex fan-out | PERF-09 |
| **Code execution / programmatic tool calling** | Many tool calls collapse into one turn; data filtered before it reaches the model | Sandbox with tool APIs exposed as functions | MCP-03, MCP-04, MCP-06 |
| **Model routing / cascades** | Cheap model for easy steps | Roles → models; cascade on failed verification | LLM-08, LLM-09 |
| **Batch APIs** | Discounted async processing | Evals, memory consolidation, indexing | PERF-11, PERF-12 |
| **Streaming + early UI** | Perceived latency | Stream deltas; show tool progress | — |
| **Speculative execution of tools** | Hide tool latency | Pre-fetch likely reads (e.g. files mentioned), warm builds | PERF-05 (API speculative execution) |
| **Predicted outputs / diff edits** | Faster rewrites | Prefer patch/str_replace edits over whole-file regeneration | PERF-13 |
| **Skeleton-of-thought** | Parallel long-form generation | Outline, then parallel subagents expand sections | PERF-10 |
| **Fast inference modes / providers** | Higher tokens per second | Expose a "fast" model alias | — |

## Inference-side techniques (only if we self-host)
- **PagedAttention / vLLM**: efficient KV memory and prefix sharing [PERF-04].
- **RadixAttention / SGLang**: automatic KV reuse across calls that share prefixes. Branching agent calls become cheap [PERF-05].
- **Speculative decoding**: 2–3x with an identical output distribution [PERF-06]; EAGLE about 2.7–3.5x [PERF-07]; Medusa uses heads instead of a draft model [PERF-08].

Even when hosted, these explain *why* stable shared prefixes are cheap, which justifies the cache-first layout.

## Recommendations for our harness
1. **Cost and latency ledger** per turn: TTFT, total latency, input / cached / output tokens, cost, cache hit %, tool time. Show it in the UI and traces.
2. **Cache-first prompt layout** with a regression test (Ch. 01).
3. **Concurrent tool executor** with per-tool concurrency safety flags: read-only tools run in parallel, mutating tools serialise.
4. **Timeouts and background tasks** for long commands, with the agent polling or receiving notifications instead of blocking.
5. **Reasoning-effort policy** per role (high for planning, low for routine edits).
6. **Optional code-execution mode** for data-heavy MCP workflows [MCP-03].
7. **Batch tier** for non-interactive jobs.

## Open questions
- What's our latency target per interactive turn (p50/p95)? This decides how aggressively we route to fast models.
- Pre-fetching risks wasted tokens. Measure before enabling.

<!-- SOURCES:PERF -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| PERF-01 | [Prompt caching (Claude)](https://docs.claude.com/en/docs/build-with-claude/prompt-caching) | Anthropic | current | Must read |
| PERF-02 | [Prompt caching (OpenAI)](https://platform.openai.com/docs/guides/prompt-caching) | OpenAI | current | Should read |
| PERF-03 | [Context caching (Gemini)](https://ai.google.dev/gemini-api/docs/caching) | Google | current | Optional |
| PERF-04 | [Efficient Memory Management for LLM Serving with PagedAttention (vLLM)](https://arxiv.org/abs/2309.06180) | Kwon et al. (UC Berkeley) | 2023-09-12 | Optional |
| PERF-05 | [SGLang: Efficient Execution of Structured LM Programs (RadixAttention)](https://arxiv.org/abs/2312.07104) | Zheng et al. (Stanford, UC Berkeley) | 2023-12-12 | Optional |
| PERF-06 | [Fast Inference from Transformers via Speculative Decoding](https://arxiv.org/abs/2211.17192) | Leviathan, Kalman, Matias (Google) | 2022-11-30 | Optional |
| PERF-07 | [EAGLE: Speculative Sampling Requires Rethinking Feature Uncertainty](https://arxiv.org/abs/2401.15077) | Li et al. | 2024-01-26 | Optional |
| PERF-08 | [Medusa: LLM Inference Acceleration with Multiple Decoding Heads](https://arxiv.org/abs/2401.10774) | Cai et al. | 2024-01-19 | Optional |
| PERF-09 | [An LLM Compiler for Parallel Function Calling (LLMCompiler)](https://arxiv.org/abs/2312.04511) | Kim et al. (UC Berkeley) | 2023-12-07 | Must read |
| PERF-10 | [Skeleton-of-Thought: Prompting LLMs for Efficient Parallel Generation](https://arxiv.org/abs/2307.15337) | Ning et al. (Tsinghua, Microsoft) | 2023-07-28 | Optional |
| PERF-11 | [Message Batches API](https://docs.claude.com/en/docs/build-with-claude/batch-processing) | Anthropic | current | Should read |
| PERF-12 | [Batch API](https://platform.openai.com/docs/guides/batch) | OpenAI | current | Optional |
| PERF-13 | [Predicted Outputs](https://platform.openai.com/docs/guides/predicted-outputs) | OpenAI | current | Optional |
<!-- /SOURCES -->
