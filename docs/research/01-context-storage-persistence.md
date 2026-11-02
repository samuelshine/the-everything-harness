# 01 — Context optimisation, storage & persistence

## Why it matters
The context window is the model's entire working memory, and its quality degrades as it fills. Chroma tested 18 models and found that every one degrades non-uniformly with input length, even on trivial tasks; needle-in-a-haystack scores overstate real long-context ability [CTX-05]. Models also use the start and end of context better than the middle [CTX-06]. Anthropic frames the job as finding "the smallest set of high-signal tokens" that maximises the chance of the desired outcome [CTX-01]. Cost and latency are context problems too: in production agents, input outweighs output roughly 100:1, so prefill and cache hit rate dominate the bill [CTX-04].

## Taxonomy (LangChain's four verbs) [CTX-07]
| Verb | Meaning | Harness mechanisms |
|------|---------|--------------------|
| **Write** | Save information outside the window | scratchpads, todo/progress files, memory tool, git commits |
| **Select** | Pull the right information in | AGENTS.md/CLAUDE.md, retrieval, memory search, just-in-time file reads, tool search |
| **Compress** | Keep only what's needed | compaction/summaries, tool-result clearing, output truncation, LLMLingua-style compression |
| **Isolate** | Split context across boundaries | subagents (fork vs isolated), sandboxes and code execution, state objects outside the prompt |

## State of the art

### In-window management
- **Compaction.** When nearing the limit, summarise the history and restart with the summary plus recent turns. Keep architectural decisions, unresolved bugs and open tasks; drop redundant tool output [CTX-01]. Anthropic's March 2026 harness found Sonnet 4.5 showed "context anxiety" that compaction didn't cure; **full context resets with structured handoff artifacts** worked better [FBK-08].
- **Tool-result clearing (context editing).** Remove stale tool calls and results first. They're the bulkiest and least needed content. Anthropic reports +29% on an internal agentic-search eval from editing alone, and +39% combined with the memory tool [CTX-02].
- **Keep errors in context.** Failed actions and stack traces help the model avoid repeating them. Don't scrub them [CTX-04].
- **Recitation.** Manus rewrites a `todo.md` at the end of context to keep goals in the high-attention zone [CTX-04].
- **Positioning.** Instructions go in the system prompt, and the current goal and state go in the latest message, avoiding the "lost middle" [CTX-06].

### Cache-aware layout [CTX-04, PERF-01, PERF-02]
- Use a stable prefix order: **tools → system → long-lived docs → history**. Never put timestamps or other volatile values in the prefix.
- History is append-only. Serialise JSON deterministically (sorted keys).
- **Don't add or remove tools mid-session**: that invalidates the cache, and earlier turns would reference missing tools. Mask tool availability (logit masking/prefill, or "not available in this mode" errors) instead [CTX-04]. Deferred tool search achieves the same thing by appending definitions rather than mutating the prefix [MCP-04].
- Treat cache hit rate as a first-class metric in the cost ledger.

### Out-of-window storage (memory)
| Approach | Idea | When to use | Sources |
|----------|------|-------------|---------|
| **Files + grep** | Agent reads and writes markdown and JSON; the file system is unbounded, persistent memory | Default. Transparent, diffable, model-agnostic | CTX-02, CTX-03, CTX-04 |
| **Tiered OS-style memory** | Core (always in context, self-editable blocks), recall (conversation search), archival (vector) | Long-lived assistants | CTX-08 |
| **Extract → consolidate → retrieve** | LLM extracts facts and decides ADD/UPDATE/DELETE/NOOP against existing memory | User preferences across sessions | CTX-10 |
| **Temporal knowledge graph** | Entities and edges with validity intervals | Facts change over time | CTX-11 |
| **Linked notes (Zettelkasten)** | Notes link to and update each other | Research/knowledge bases | CTX-12 |
| **Evolving playbooks** | Itemised bullets updated by generate → reflect → curate deltas | Self-improving agent instructions | CTX-13 |
| **Sleep-time compute** | Background agent consolidates memory between sessions | Cut per-query latency | CTX-09 |

Rule from ACE [CTX-13]: **never let an LLM rewrite the whole memory**. Monolithic rewrites cause "brevity bias" and "context collapse". Apply small, itemised deltas.

### Retrieval
Contextual retrieval (prepend chunk-specific context before embedding, add BM25, then rerank) cut retrieval failures by 49%, or 67% with reranking [CTX-16]. For code, agentic search (grep/glob/read) is often better than embeddings because it's always fresh and precise [CTX-01, AGT-07]. Use both: grep-first tools, with optional semantic indexing for large corpora.

### Very large inputs
**Recursive Language Models** put the input into a REPL variable. The model writes code to slice it and recursively calls sub-LLMs over the pieces, handling inputs about 100x larger than the window [CTX-14]. **Code execution with MCP** applies the same idea to tool results: filter 10,000 rows down to 5 before anything reaches the model [MCP-03].

### Persistence across sessions (long-running work) [CTX-03]
Anthropic's long-running harness uses an **initializer agent** to create `init.sh`, a JSON feature list (all features initially failing), a `progress.txt` and an initial git commit. Each **coding session** then:
1. Reads the progress file and git log.
2. Runs the init script and a smoke test.
3. Picks **one** feature.
4. Implements and tests it end to end.
5. Marks it passing, commits, and updates progress.

A JSON feature list is safer than markdown because the model is less likely to rewrite it wholesale. Agents may only flip a status field.

### Subagent context modes [CTX-19]
| Mode | What the child gets | Best for |
|------|--------------------|----------|
| **Isolated** | Task brief only | Verifiers/reviewers (unanchored), parallel researchers |
| **Fork** | Parent's full conversation (reuses prompt cache) | Continuing workers, memory/summariser agents |

## Recommendations for our harness
1. **Context assembler module** with named sections (tools, system, project guidance, memory, history, scratch) and **per-section token budgets**. Log section sizes on every call.
2. **Cache-stable layout** by construction: deterministic serialisation, explicit cache breakpoints, and a test that fails if the prefix changes between turns.
3. **Three compression stages**, cheapest first:
   - truncate and clear old tool results (keep a pointer: file path or URL, so it's restorable);
   - compaction summary using a structured template;
   - full reset with handoff artifacts for very long runs.
4. **File-backed memory tool** (`view/create/str_replace/insert/delete/rename` under a `/memories` root, mirroring [CTX-02]). Pluggable backends later (Mem0/Zep/Letta) behind the same interface.
5. **Project guidance loader**: AGENTS.md + CLAUDE.md hierarchy (enterprise → user → project → directory), with imports [CTX-18, SKL-07].
6. **Session persistence**: append-only JSONL event log per session (messages, tool calls, results, usage), resumable and forkable. Checkpoint file-system changes (git or snapshots) so a "rewind" is possible.
7. **Long-run mode** with an initializer pattern and progress/feature artifacts [CTX-03].
8. **Fork vs isolated** as an explicit subagent parameter [CTX-19].
9. A **background consolidation job** (batch-priced) that distils sessions into memory deltas [CTX-09, CTX-13, PERF-11].

## Open questions
- How do we detect "context rot" online? Candidates: rising repeated tool calls, contradicting earlier decisions, drops in eval pass rate by context length.
- What is the compaction trigger: a fixed % of the window, or a learned threshold per model?
- How should memory be scoped (user / project / org) and what are the privacy rules?

<!-- SOURCES:CTX -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| CTX-01 | [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Anthropic | 2025-09-29 | Must read |
| CTX-02 | [Managing context on the Claude Developer Platform (context editing + memory tool)](https://www.anthropic.com/news/context-management) | Anthropic | 2025-09-29 | Must read |
| CTX-03 | [Effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) | Anthropic (Justin Young) | 2025-11-26 | Must read |
| CTX-04 | [Context Engineering for AI Agents: Lessons from Building Manus](https://manus.im/blog/Context-Engineering-for-AI-Agents-Lessons-from-Building-Manus) | Manus (Yichao 'Peak' Ji) | 2025-07-18 | Must read |
| CTX-05 | [Context Rot: How Increasing Input Tokens Impacts LLM Performance](https://research.trychroma.com/context-rot) | Chroma (Hong, Troynikov, Huber) | 2025-07 | Must read |
| CTX-06 | [Lost in the Middle: How Language Models Use Long Contexts](https://arxiv.org/abs/2307.03172) | Liu et al. (Stanford) | 2023-07-06 | Should read |
| CTX-07 | [Context Engineering for Agents (write / select / compress / isolate)](https://www.langchain.com/blog/context-engineering-for-agents) | LangChain (Lance Martin) | 2025-07-02 | Must read |
| CTX-08 | [MemGPT: Towards LLMs as Operating Systems](https://arxiv.org/abs/2310.08560) | Packer et al. (UC Berkeley) / Letta | 2023-10-12 | Must read |
| CTX-09 | [Sleep-time Compute: Beyond Inference Scaling at Test-time](https://arxiv.org/abs/2504.13171) | Lin, Packer, Wooders et al. (Letta) | 2025-04-17 | Should read |
| CTX-10 | [Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory](https://arxiv.org/abs/2504.19413) | Chhikara et al. (Mem0) | 2025-04-28 | Should read |
| CTX-11 | [Zep: A Temporal Knowledge Graph Architecture for Agent Memory](https://arxiv.org/abs/2501.13956) | Rasmussen et al. (Zep) | 2025-01 | Optional |
| CTX-12 | [A-MEM: Agentic Memory for LLM Agents](https://arxiv.org/abs/2502.12110) | Xu et al. (Rutgers) | 2025-02 | Optional |
| CTX-13 | [Agentic Context Engineering (ACE): Evolving Contexts for Self-Improving LMs](https://arxiv.org/abs/2510.04618) | Zhang et al. (Stanford, SambaNova, UC Berkeley) | 2025-10 | Must read |
| CTX-14 | [Recursive Language Models](https://arxiv.org/abs/2512.24601) | Zhang, Kraska, Khattab (MIT) | 2025-12-31 | Should read |
| CTX-15 | [Generative Agents: Interactive Simulacra of Human Behavior](https://arxiv.org/abs/2304.03442) | Park et al. (Stanford, Google) | 2023-04-07 | Optional |
| CTX-16 | [Introducing Contextual Retrieval](https://www.anthropic.com/news/contextual-retrieval) | Anthropic | 2024-09 | Should read |
| CTX-17 | [LLMLingua: Compressing Prompts for Accelerated Inference](https://arxiv.org/abs/2310.05736) | Jiang et al. (Microsoft) | 2023-10 | Optional |
| CTX-18 | [Claude Code memory (CLAUDE.md hierarchy)](https://docs.claude.com/en/docs/claude-code/memory) | Anthropic | current | Should read |
| CTX-19 | [Organizing Context in a Multi-Agent Harness](https://www.langchain.com/blog/organizing-context-in-a-multi-agent-harness) | LangChain (Bengre, Curme) | 2026-09-08 | Must read |
<!-- /SOURCES -->
