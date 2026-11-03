# 0002 — Provider layer

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/02-multi-llm-providers.md`, `docs/research/12-model-routing-and-local-models.md` §3–4, `docs/research/03-performance.md`; sources [LLM-01], [LLM-04], [LLM-07], [LLM-17], [RTE-08]–[RTE-13], [PERF-01]

## Context
Everything in `teh` sits on the provider layer: the loop, the context engine, cost accounting and model routing (ADR-0014). It has to:
- Support the main cloud providers **with full fidelity**: prompt-cache breakpoints, reasoning items that must round-trip unchanged, parallel tool calls and token accounting [LLM-01, PERF-01].
- Support **any local model** (Ollama, LM Studio, llama.cpp, vLLM), including Ollama's context-size trap, where the default is 4k under 24 GiB of VRAM and longer input is truncated silently [RTE-08, RTE-10].
- Support the **ChatGPT plan** request profile (`store:false`, `stream:true`, full history, no sampling parameters) [LLM-17] and API keys (ADR-0009).
- Work **without paid keys in tests**, because development happens without them for now.
- Stay inside one compiled Bun binary (ADR-0001).

## Options considered
1. **LiteLLM** (Python SDK or proxy) [LLM-04]. Huge provider coverage and a mature router, but it adds a Python sidecar to a single-binary CLI, and the translation layer loses provider features we depend on. Users can still point `teh` at a LiteLLM proxy through option 4's generic adapter.
2. **Vercel AI SDK** [LLM-07]. TypeScript, good abstractions and many providers. But it normalises away details we need control of: exact cache-breakpoint placement, opaque reasoning round-trips, the ChatGPT-plan profile and Ollama's `num_ctx`. It would also make a third-party abstraction our core data model.
3. **OpenRouter only.** One integration, but it puts a paid intermediary in front of every user and adds nothing for local models.
4. **Own thin adapters over official SDKs**, behind one interface with our own item-based message model (chosen).

## Decision
Option 4.

**Canonical model.** Conversations are lists of typed items, as sketched in doc 02:
- text;
- tool call and tool result;
- reasoning (opaque, tagged with the provider that produced it);
- image and file.

Reasoning items go back unchanged only to the provider that made them. Otherwise they are dropped, or reduced to their summary, when the model changes.

**Interface.** Each adapter implements:
```ts
interface Provider {
  id: string;
  listModels(): Promise<ModelInfo[]>;
  probe(model: string): Promise<ProbeResult>;          // tool-call check + real context window
  stream(req: ModelRequest, signal: AbortSignal): AsyncIterable<StreamEvent>;
  countTokens?(req: ModelRequest): Promise<number>;
}
type StreamEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text?: string; opaque?: unknown }
  | { type: "tool_call_start" | "tool_call_delta" | "tool_call_end"; /* … */ }
  | { type: "usage"; input: number; cachedRead: number; cacheWrite: number; output: number }
  | { type: "stop"; reason: "end" | "tool_use" | "max_tokens" | "refusal" | "error" };
```

**Adapters in the first release:**

| Adapter | Covers | Notes |
|---|---|---|
| `anthropic` | Anthropic API (Bedrock and Vertex later) | Explicit cache breakpoints, thinking blocks, token counting |
| `openai` | OpenAI Responses API with an API key, and the **ChatGPT plan** profile (ADR-0009) | The profile strips unsupported fields and always sends full history [LLM-17] |
| `openai-compatible` | Chat Completions servers: LM Studio, llama.cpp, vLLM, OpenRouter, Groq, LiteLLM proxy, any gateway | Feature-detected. No assumptions beyond the base spec |
| `ollama` | Ollama's native `/api/chat` | Sets `num_ctx`, reads `/api/show`, lists and pulls models. Native API because the OpenAI-compatible path can ignore context settings [RTE-10] |
| `fake` | Tests | Scripted responses, including tool calls, errors and streaming chunking. Used by every engine test |

Gemini is next. Claude Code and Codex are **not providers**. They are delegation backends behind the subagent interface (ADR-0009).

**Capability registry.** For each model we keep:
- context and output limits;
- tool calling, parallel tools, reasoning controls, images and structured output;
- caching style (explicit or implicit);
- prices (input, cached input, cache write, output).

Sources, from lowest to highest precedence:
1. a **models.dev snapshot bundled at build time** [RTE-13];
2. an optional refresh, skipped in local-only mode;
3. live **probe** results, cached in `~/.teh/cache/`;
4. **user overrides** in settings.

The router, context engine and UI read capabilities only from this registry.

**Cost model.** Cost is computed per **auth route**:
- an API key costs the registry price;
- a ChatGPT plan costs nothing per token but has plan limits;
- a local model costs nothing per token;
- a delegated run costs whatever the user's own subscription charges.

`/cost` shows both tokens and money.

**Errors.** Each adapter maps its errors onto one taxonomy:

| Error | Response |
|---|---|
| `rate_limited` | Back off, honouring retry-after |
| `overloaded` | Fall back to the next model for this turn only, as Claude Code does [RTE-01] |
| `context_exceeded` | Compact and retry once |
| `content_filtered` | Surface it to the user |
| `auth` | Fail with a fix-it message |
| `bad_request` | Fail and log the request shape, never its content |

**Testing.**
- **Contract tests** run the same scripted conversation (text, parallel tool calls, an error, images) through every adapter and require equivalent canonical items.
- **Recorded HTTP fixtures** let the contract tests run without keys.
- **Live runs are opt-in:** set an API key, or have a local Ollama running.
- The first agent milestone must pass end to end against **`fake` in CI** and against **Ollama locally**.

## Consequences
- **We maintain four adapters** and keep them current as APIs change. Contract tests and recorded fixtures catch drift, and doc 11's watch list tracks provider changelogs.
- **Official SDKs are dependencies** (`@anthropic-ai/sdk`, `openai`). Both were proven inside the compiled binary in the ADR-0001 spike.
- **Ollama setup is part of the product.** When a model's real window is too small for the agent's first request, `teh` refuses with the exact fix (`OLLAMA_CONTEXT_LENGTH=65536`) rather than letting Ollama truncate silently [RTE-08].
- **Prompt profiles per model family** (system-prompt overlay, edit format, tool-description style) live beside the adapters but are chosen from the registry, not hard-coded per provider.
- **Revisit** if keeping fidelity across four adapters costs more than it is worth. The fallback is adopting the AI SDK for long-tail providers only, while keeping our own canonical model.
