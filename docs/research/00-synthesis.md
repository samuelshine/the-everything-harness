# 00 — Synthesis: what the research says about building a harness

*Research date: 2026-11-02. Source IDs like `[CTX-01]` refer to rows in [`sources.csv`](sources.csv) and the "All sources" tab of the Google Sheet.*

## 1. One-paragraph answer

A harness is the runtime around a model: the loop, context assembly, tools, memory, permissions, verification and UX. The industry evidence is consistent: **the harness moves results as much as the model does** [BAS-02, OTH-11]. The most valuable investments are, in order: (1) a disciplined context pipeline that keeps the window small, cache-stable and high-signal [CTX-01, CTX-04, CTX-05]; (2) verification grounded in *external* signals — tests, linters, a separate evaluator — rather than self-reflection [FBK-03, FBK-08, FBK-09, FBK-14]; (3) open, portable extension formats — MCP for tools, SKILL.md for skills, AGENTS.md for project guidance, hooks for deterministic rules [MCP-01, SKL-02, SKL-07, FBK-10]; (4) a provider layer whose internal message model is item-based, so features like reasoning persistence and caching survive translation [LLM-01]; (5) sandbox-first security that makes autonomy safe instead of interrupting it with prompts [OTH-04, OTH-01]. Multi-agent delegation pays off for breadth-first, read-heavy work and costs ~15x tokens; it is a tool, not a default [AGT-02, AGT-03, AGT-04].

**Product framing:** the harness starts as a **terminal app usable like Claude Code**. Requirements are in [10](10-terminal-harness.md), and lessons from competitors are in [11](11-competitive-landscape.md). The strongest single data points:
- Factory's Droid beat Claude Code by ~15 points on Terminal-Bench using the same model [CMP-16].
- Anthropic traced a month of Claude Code quality complaints to harness changes, not the model [CMP-02].

The harness is the product.

## 2. Twelve cross-cutting principles

| # | Principle | Evidence |
|---|-----------|----------|
| 1 | **Context is a budget, not a bucket.** Performance decays with length well before the limit; place critical info at the edges. | CTX-01, CTX-05, CTX-06 |
| 2 | **Design for the KV cache.** Stable prefix, append-only history, deterministic serialisation, don't add or remove tools mid-session (mask instead). Cached tokens are ~10x cheaper. | CTX-04, PERF-01, PERF-02 |
| 3 | **Externalise state to files.** Progress notes, feature lists, git history and memory files beat ever-longer transcripts, and they survive resets. | CTX-02, CTX-03, AGT-07 |
| 4 | **Incremental memory updates, never full rewrites.** Full LLM rewrites cause "context collapse". | CTX-13, CTX-10 |
| 5 | **Load capabilities just in time.** Skills (progressive disclosure), tool search, and code-execution over MCP keep definitions out of context until needed. | SKL-01, MCP-03, MCP-04 |
| 6 | **Verification must be external.** Intrinsic self-correction is unreliable; tests, tool checks, and a separate skeptical evaluator work. | FBK-03, FBK-04, FBK-08 |
| 7 | **Deterministic beats probabilistic for rules.** Hooks, linters and structural tests enforce rules that a prompt can only request. | FBK-09, FBK-10, FBK-14 |
| 8 | **One writer per artifact.** Parallel agents conflict on implicit decisions; parallelise reading and research, serialise writing (or coordinate via tests and locks). | AGT-03, AGT-09, CTX-19 |
| 9 | **Sandbox first, then autonomy.** OS-level isolation reduced prompts by 84%; avoid the lethal trifecta per session. | OTH-04, OTH-01, OTH-03 |
| 10 | **Evals and traces from day one.** Grade outcomes, track pass^k, emit OpenTelemetry GenAI spans; use traces to optimise prompts (GEPA). | FBK-13, OTH-07, PRM-03 |
| 11 | **Version the harness like a model.** System prompt, defaults and caching changes get evals, ablations, soak periods and a changelog; users can pin. | CMP-02, CMP-01 |
| 12 | **Parse, don't prefix-match.** Permission decisions on shell commands need a real parser; this is the most repeated vulnerability class across agents. | CMP-07, CMP-13, TRM-04 |

## 3. Reference architecture

Grouped by the three layers in [BAS-03]: context, harness, loop. The capability checklist is cross-checked against Microsoft's published harness matrix [BAS-01].

```
┌──────────────────────────── UX surfaces ─────────────────────────────┐
│  TUI (first) · headless -p · ACP (editors) · local server  [TRM-01]  │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ events (stream, approvals, progress)
┌───────────────────────────────▼──────────────────────────────────────┐
│ LOOP ENGINE                                                          │
│  gather context → act (tools) → verify → repeat      [AGT-07, AGT-10] │
│  modes: plan / execute · bounded looping · checkpoints · resume      │
│  delegation: subagents (fork | isolated) · agents-as-tools · handoffs │
├──────────────────────────────────────────────────────────────────────┤
│ CONTEXT ENGINE                         │ GUIDANCE & FEEDBACK          │
│  assembler w/ per-section token budgets│  hooks (pre/post tool, stop) │
│  cache-stable layout + breakpoints     │  evaluator role, judges      │
│  compaction · tool-result clearing     │  lint/test → agent-readable  │
│  memory tiers (core/recall/archival)   │  guardrail tripwires         │
│  retrieval (contextual + BM25)         │  reflection on retry         │
├──────────────────────────────────────────────────────────────────────┤
│ CAPABILITIES                                                         │
│  built-in tools (ACI-quality)  · MCP client (stdio/HTTP/OAuth)        │
│  tool search / deferred loading · code-execution mode (sandboxed)     │
│  skills (SKILL.md, progressive)  · plugins (bundles + marketplaces)   │
├──────────────────────────────────────────────────────────────────────┤
│ PROVIDER LAYER                                                       │
│  item-based internal message model · native adapters per vendor      │
│  capability flags · router (rules → learned) · fallbacks · cascades   │
├──────────────────────────────────────────────────────────────────────┤
│ PLATFORM: sandbox (fs+net) · permission engine · secrets · storage   │
│           OTel GenAI tracing · cost ledger · eval runner              │
└──────────────────────────────────────────────────────────────────────┘
```

## 4. Suggested build order

| Phase | Deliverable | Why first | Key sources |
|-------|-------------|-----------|-------------|
| 0 | **Eval harness + tracing skeleton** (task set, outcome graders, pass^k, OTel spans) | Every later decision needs measurement | FBK-13, OTH-07, OTH-11 |
| 1 | **Provider layer** with an item-based message model; Anthropic + OpenAI native adapters; capability flags | Everything sits on it, and it's hard to retrofit | LLM-01, LLM-02, LLM-04 |
| 2 | **Core loop + built-in tools** (read/edit/search/bash) designed to ACI quality; parallel tool execution; JSONL sessions + headless `-p` | Tool ergonomics drive success; headless is the first client | AGT-07, OTH-08, MCP-05, PERF-09, TRM-06 |
| 2b | **TUI v1**: inline differential renderer, input editor, slash commands, diffs, interrupt/queue, checkpoints, plan mode | Makes it usable like Claude Code | TRM-08, TRM-31, TRM-05 |
| 3 | **Context engine**: cache-stable layout, compaction, tool-result clearing, AGENTS.md/CLAUDE.md loading, file memory | Biggest cost and quality lever | CTX-01, CTX-02, CTX-04, PERF-01 |
| 4 | **Sandbox + permission engine** (fs/net isolation, allow/deny rules, trifecta detection) | Needed before any autonomy | OTH-04, OTH-01, OTH-05 |
| 5 | **Hooks** (lifecycle events) + **MCP client** + **skills loader** | Open extension surface | FBK-10, MCP-01, SKL-02 |
| 6 | **Subagents** (fork/isolated, tool allowlists, model per agent) + evaluator role | Delegation and verification | AGT-08, CTX-19, FBK-08 |
| 7 | **Plugins & marketplaces**, tool search, code-execution mode | Scale the ecosystem | MCP-11, MCP-04, MCP-03 |
| 8 | **Prompt optimiser** (GEPA over traces), router, long-term memory backend | Needs data from earlier phases | PRM-03, LLM-08, CTX-10 |

## 5. Decisions to make

These are open decisions for you. The research gives a lean, not a final answer.

1. **Language/runtime.** TypeScript gives you the Vercel AI SDK, the MCP TS SDK and ACP. Python gives you DSPy/GEPA, LiteLLM and research code. Rust gives Codex-style single binaries and native sandbox bindings [CMP-15]. *Lean:* TypeScript on Bun (compiled to one binary), with a strict engine/TUI split and a language-neutral event protocol, plus a Python sidecar for optimisation. See [10 §14](10-terminal-harness.md).
2. **Wrap LiteLLM, or write our own adapters?** *Lean:* write our own native adapters for the top 2–3 providers, for fidelity on caching, reasoning and tool features, and use LiteLLM/OpenRouter as a "long tail" adapter.
3. **Memory backend.** Plain files plus grep ([CTX-02], [CTX-04]) vs a vector/graph store ([CTX-10], [CTX-11]). *Lean:* files first, with an optional pluggable store behind a memory-tool interface.
4. **Multi-agent default.** *Lean:* single writer by default; parallel subagents only for research and verification [AGT-03, CTX-19].
5. **Security posture.** Which sandbox (macOS Seatbelt / Linux bubblewrap / containers) and whether network egress is allow-listed by default. *Lean:* yes, allow-list by default [OTH-04].

6. **Default approval posture.** Prompt-by-default, or sandboxed auto mode with a reviewer agent [TRM-19, TRM-04]? *Lean was:* sandboxed `workspace-write` + prompts only for escapes, as Codex does. *Decided:* ask before every change, with the sandbox still on underneath ([ADR-0008](../adr/0008-default-approval-posture.md)).
7. **Subscription access.** Can users spend a Claude or ChatGPT subscription? *Accepted:* ChatGPT plan through Sign in with ChatGPT (needs an open-source repo); Claude only by delegating to the user's own Claude Code; never reuse first-party logins [LLM-11, LLM-15]. See [ADR-0009](../adr/0009-provider-auth-and-subscriptions.md).

## 6. What's moving fast (re-check quarterly)

- MCP spec: Tasks moving to an extension, auth changes, MCP Apps/UI [MCP-02].
- Agent Skills spec and cross-vendor adoption [SKL-02, SKL-04].
- OpenTelemetry GenAI conventions (still "development" status) [OTH-07].
- Provider-native context features: server-side compaction, memory, tool search [CTX-02, MCP-04].
- Benchmarks for harnesses (Terminal-Bench 2.x / Harbor) [OTH-11, CMP-17].
- Competitor releases, postmortems and CVEs (see the watch list in [11](11-competitive-landscape.md)).
