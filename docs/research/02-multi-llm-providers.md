# 02 — Multi-LLM provider connector

## Why it matters
The harness must not be locked to one model vendor, but naive "OpenAI-compatible everywhere" loses the features that matter most for agents: prompt caching controls, reasoning/thinking blocks and their persistence across tool calls, server-side tools, structured outputs, and context-management features. Anthropic's and Google's OpenAI-compat layers are explicitly lossy [LLM-02, LLM-03].

## Landscape
| Option | Type | Strengths | Weaknesses | Sources |
|--------|------|-----------|-----------|---------|
| Native SDKs (Anthropic, OpenAI Responses, Gemini) | Direct | Full fidelity | N adapters to maintain | LLM-01, LLM-02 |
| **LiteLLM** | SDK + self-hosted gateway | 100+ providers; router (retries, fallbacks, cooldowns, load balance); budgets, virtual keys, logging | Lowest-common-denominator schema; extra hop if using the proxy | LLM-04 |
| **OpenRouter** | Hosted gateway | One key; `models` fallback list; provider ordering/pinning, price/latency sorting | Third party sees traffic; feature pass-through varies | LLM-05 |
| **any-llm** | Thin SDK | Uses each vendor's official SDK underneath; no proxy | Python only; smaller ecosystem | LLM-06 |
| **Vercel AI SDK** | TS SDK | Unified generate/stream/tool API, provider registry, middleware | TS only; abstraction may hide provider extras | LLM-07 |
| vLLM / Ollama | Self-host | Local/open models via OpenAI-style endpoint | Tool-calling quality varies by model | LLM-10 |

## Design: the internal message model
OpenAI's Responses API shows where the industry is going. Output is a list of typed **items** (message, function_call, function_call_output, reasoning, web_search_call, …) rather than `choices[].message`, and reasoning persists across tool calls [LLM-01]. Anthropic's Messages API is similar: content blocks of `text`, `tool_use`, `tool_result`, `thinking`, and so on. **Our canonical format should be block/item-based**:

```ts
type Item =
  | { kind: "text"; role: "user"|"assistant"|"system"; text: string; cache?: CacheHint }
  | { kind: "tool_call"; id: string; name: string; args: unknown }
  | { kind: "tool_result"; callId: string; content: Part[]; isError?: boolean }
  | { kind: "reasoning"; provider: string; opaque: unknown; summary?: string } // round-trip untouched
  | { kind: "image" | "file"; ... };
```

Key rules:
- **Reasoning blocks are opaque and provider-specific.** Round-trip them to the *same* provider unchanged (signatures, encrypted content). Drop them, or keep only the summary, when switching providers mid-session.
- **Capability flags per model**: `supportsParallelTools`, `supportsCaching(explicit|implicit)`, `maxContext`, `supportsStructuredOutput`, `reasoningControls`, `supportsImagesInToolResults`, pricing (input / cached input / output). The router, context engine and UI read these.
- **Per-family prompt fragments**: prompting guides diverge. GPT-5 is "extremely literal" and has an eagerness control [PRM-10]; Claude 4.x responds to explicit context and motivation and XML structure [PRM-09]. Keep a small model-family overlay on the system prompt.
- **Normalise usage accounting**: input, cached-read, cache-write and output tokens, plus cost, so the cost ledger is provider-neutral.
- **Errors → retry taxonomy**: rate-limit (backoff), overloaded (fallback model), context-length (compact and retry), content-filter (surface), auth (fail).

## Routing, fallbacks and cascades
- **Fallback chains** (OpenRouter's `models`, LiteLLM's Router): an ordered list per role, with cooldowns on failing deployments [LLM-04, LLM-05].
- **Cascades** (FrugalGPT): try the cheap model and escalate when verification fails or confidence is low. FrugalGPT reports up to 98% cost reduction at equal quality on its tasks [LLM-09].
- **Learned routers** (RouteLLM): a classifier trained on preference data picks strong vs weak; >2x cost savings with little quality loss [LLM-08].
- **Role-based model assignment** is the practical form: a strong model for the orchestrator and planner, a cheaper one for subagents, summarisation and compaction. Anthropic's research system used an Opus lead with Sonnet subagents [AGT-02].

- **Update (2026-11-03):** newer evidence is more sceptical. Independent benchmarks find most routers, commercial ones included, fail to reliably beat a simple single-model baseline [RTE-03, RTE-04]. For coding agents, switching models mid-session also forfeits the prompt cache. See [doc 12](12-model-routing-and-local-models.md) for the routing design and for local models.

## Recommendations for our harness
1. Write **native adapters** for Anthropic Messages and OpenAI Responses first (and Gemini next), behind one `Provider` interface: `stream(request) → AsyncIterable<Event>`.
2. Add a **generic OpenAI-compatible adapter** covering vLLM, Ollama, OpenRouter, LiteLLM proxy and Groq, as the long tail.
3. **Config schema**: named model aliases → `{provider, model, params, fallbacks[]}`; roles (`main`, `fast`, `subagent`, `compact`, `judge`) → aliases.
4. **Stream events** normalised to a small set: `text_delta`, `reasoning_delta`, `tool_call_start/delta/end`, `usage`, `stop`.
5. Build **contract tests** per adapter: the same scripted conversation (tools, parallel calls, images, errors) must produce equivalent canonical items.
6. Defer learned routing. Start with role-based assignment plus cascade-on-failed-verification.

## Authentication and subscriptions
Users often already pay for a Claude or ChatGPT subscription. Whether a third-party harness may spend it depends on the provider (checked 2026-11-03; decision in [ADR-0009](../adr/0009-provider-auth-and-subscriptions.md)):

| Provider | In our own loop | Via the provider's own agent |
|---|---|---|
| **Anthropic** (Pro/Max) | **Not allowed.** Subscription OAuth is reserved for Claude Code and Anthropic apps; third parties may not offer Claude.ai login, route requests through plan credentials, or store Claude.ai tokens, and this includes Agent SDK products [LLM-11, LLM-12]. Enforced with bans since January 2026 [LLM-13]. Use API keys or a cloud provider. | **Allowed:** a user may sign in to the *unmodified* `claude` binary, even when another product runs it [LLM-11]. We delegate tasks to it (headless or ACP) without touching its credentials. |
| **OpenAI** (Plus/Pro) | **Allowed for open-source, locally hosted apps** through Sign in with ChatGPT plan usage: dynamic client registration with PKCE, no client secret [LLM-14, LLM-15, LLM-16]. Restricted Responses profile: `store:false`, `stream:true`, full history in `input`, no sampling params, no hosted tools [LLM-17]. Commercial or hosted apps need partner approval. | **Allowed:** delegate to the user's installed `codex` (app-server or `exec`) [LLM-19, LLM-20], or run app-server on our own plan token [LLM-18]. |

Rules that follow:
- **Never borrow a first-party login.** Do not read `~/.claude/` or `~/.codex/auth.json`, and do not copy client IDs or user agents.
- **Treat "ChatGPT plan" as a request profile on the OpenAI adapter**, with its own contract tests, rather than as a separate provider.
- **Show the auth route in the UI**, so users know whether usage hits an API bill or their plan's limits.

## Open questions
- Use the provider's server-side state (Responses `previous_response_id`) or always send the full history? *Lean:* send full history, because it's portable and auditable; use server-side state only as an optimisation.
- How should switching models mid-session be handled when reasoning items can't transfer?

<!-- SOURCES:LLM -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| LLM-01 | [Migrate to the Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses) | OpenAI | 2025-03 / current | Must read |
| LLM-02 | [OpenAI SDK compatibility](https://docs.claude.com/en/api/openai-sdk) | Anthropic | current | Should read |
| LLM-03 | [OpenAI compatibility for the Gemini API](https://ai.google.dev/gemini-api/docs/openai) | Google | current | Optional |
| LLM-04 | [LiteLLM (SDK + AI Gateway)](https://docs.litellm.ai) | BerriAI | current | Must read |
| LLM-05 | [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection) | OpenRouter | current | Should read |
| LLM-06 | [Introducing any-llm: a unified API to access any LLM provider](https://blog.mozilla.ai/introducing-any-llm-a-unified-api-to-access-any-llm-provider/) | Mozilla.ai | 2025-07 (v1.0 2025-11) | Optional |
| LLM-07 | [AI SDK (provider abstraction for TypeScript)](https://ai-sdk.dev/docs) | Vercel | current | Should read |
| LLM-08 | [RouteLLM: Learning to Route LLMs with Preference Data](https://arxiv.org/abs/2406.18665) | Ong et al. (LMSYS, UC Berkeley, Anyscale) | 2024-06 | Should read |
| LLM-09 | [FrugalGPT: How to Use LLMs While Reducing Cost and Improving Performance](https://arxiv.org/abs/2305.05176) | Chen, Zaharia, Zou (Stanford) | 2023-05-09 | Should read |
| LLM-10 | [vLLM OpenAI-compatible server](https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html) | vLLM project | current | Optional |
| LLM-11 | [Claude Code legal and compliance: authentication and credential use](https://code.claude.com/docs/en/legal-and-compliance) | Anthropic | 2026 | Must read |
| LLM-12 | [Agent SDK overview (authentication note)](https://code.claude.com/docs/en/agent-sdk/overview) | Anthropic | 2026 | Should read |
| LLM-13 | [Anthropic clarifies ban on third-party tool access to Claude](https://www.theregister.com/software/2026/02/20/anthropic-clarifies-ban-on-third-party-tool-access-to-claude/5014546) | The Register | 2026-02 | Should read |
| LLM-14 | [Sign in with ChatGPT: quickstart](https://developers.openai.com/siwc/quickstart) | OpenAI | 2026 | Must read |
| LLM-15 | [ChatGPT plan usage for open-source apps (overview)](https://developers.openai.com/siwc/token-sharing-open-source) | OpenAI | 2026 | Must read |
| LLM-16 | [Sign in with ChatGPT: registration and sign-in (open source)](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) | OpenAI | 2026 | Should read |
| LLM-17 | [Sign in with ChatGPT: preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) | OpenAI | 2026 | Must read |
| LLM-18 | [Sign in with ChatGPT: Codex app-server configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server) | OpenAI | 2026 | Should read |
| LLM-19 | [Codex authentication](https://learn.chatgpt.com/docs/auth) | OpenAI | 2026 | Should read |
| LLM-20 | [Unlocking the Codex harness: the App Server](https://openai.com/index/unlocking-the-codex-harness) | OpenAI | 2026-02 | Should read |
| LLM-21 | [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542) | OpenAI | 2026 | Optional |
<!-- /SOURCES -->
