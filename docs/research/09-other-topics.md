# 09 — Other topics you'd otherwise miss

Grouped: **A. Security & safety**, **B. Evals & benchmarks**, **C. Observability & cost**, **D. UX & surfaces**, **E. Tool/interface design**, **F. Structured output**, **G. Durability & ops**, **H. Harness basics & reference designs**.

---

## A. Security & safety
**The core threat is prompt injection**: any untrusted text the agent reads (web pages, issues, files, tool output, MCP descriptions) can carry instructions.

- **Lethal trifecta** [OTH-01]: private data + untrusted content + external communication in one agent means data can be exfiltrated. Remove at least one leg per session or task.
- **Architectural defences** [OTH-03] give six patterns:

  | Pattern | Idea |
  |---------|------|
  | Action-selector | LLM only picks from fixed actions |
  | Plan-then-execute | Plan fixed before untrusted data is seen |
  | Map-reduce | Untrusted items processed in isolated sub-calls |
  | Dual LLM | Privileged LLM never sees untrusted text; quarantined LLM processes it via symbolic references |
  | Code-then-execute | LLM writes a program; data flows only through the program |
  | Context-minimisation | Strip untrusted content before later steps |

- **CaMeL** [OTH-02]: privileged planner + quarantined LLM + interpreter that tracks data **provenance/capabilities** and checks policies before each tool call. It is provably secure on a large share of AgentDojo tasks, at some utility cost.
- **Sandboxing** [OTH-04]: OS-level filesystem (write only inside the project) and network (allow-listed domains via proxy) isolation for shell commands. Anthropic cut permission prompts by 84% internally because inside the sandbox nothing needs approval. Implementation: macOS Seatbelt, Linux bubblewrap.
- **Threat model checklists**:
  - OWASP Agentic Top 10 (2026) [OTH-05]: goal hijack, tool misuse, identity and privilege abuse, supply chain, unexpected code execution, memory/context poisoning, insecure inter-agent comms, cascading failures, human-agent trust exploitation, rogue agents.
  - OWASP LLM Top 10 [OTH-06].
- **MCP-specific** risks: tool poisoning, shadowing, rug pulls [MCP-10] (see Ch. 06).

**Harness actions**:
1. Sandbox-by-default for shell and stdio MCP servers.
2. Permission engine with allow/ask/deny rules per tool, path and domain.
3. Taint tracking: mark content from web/MCP/untrusted files, and require approval when tainted data flows into network-sending or destructive tools.
4. Secrets never in context (env passthrough, redaction in logs).
5. Protected paths (CI config, credentials, tests-under-review) via hooks.
6. An audit log.

## B. Evals & benchmarks
- Internal method: Anthropic's eval guide [FBK-13].
- **External benchmarks for harness work**:

  | Benchmark | Measures | Notes |
  |-----------|----------|-------|
  | **Terminal-Bench 2.0** [OTH-11] | 89 hard CLI tasks in containers | Harness-sensitive (same model scores very differently across harnesses); run via Harbor |
  | **SWE-bench (Verified)** [OTH-09] | Resolving real GitHub issues | Standard for coding agents |
  | **τ-bench / τ²-bench** [OTH-10] | Tool + user + policy conversations | Introduced **pass^k** reliability |
  | MCP evals / tool-search evals | Tool selection at scale | See MCP-04 |

- **Interface matters**: SWE-agent showed purpose-built agent-computer interfaces (windowed viewer, lint-on-edit, concise search) drive results [OTH-08].

**Harness actions**:
1. `eval` command running task suites in sandboxes with outcome graders.
2. pass@k and pass^k.
3. Cost and latency per task.
4. Regression gate in CI.
5. A Harbor adapter for Terminal-Bench.

## C. Observability & cost
- **OpenTelemetry GenAI semantic conventions** [OTH-07]: standard spans (`invoke_agent`, `create_agent`, `chat`/inference, `execute_tool`) and `gen_ai.*` attributes, including MCP conventions. Still in development status, so pin versions. Emitting these makes the harness viewable in Langfuse, Arize Phoenix, Datadog, Honeycomb and others with no custom integration.
- Trace content (prompts, outputs) should be **opt-in** because of PII and secrets.
- **Cost ledger**: tokens by type (input / cache-read / cache-write / output), cost by model, per session, agent and tool; budget alerts.

## D. UX & surfaces
- **Editors**: ACP [MCP-12].
- **Web/desktop front-ends**: AG-UI event stream [OTH-13].
- **Must-have interaction features** (from Claude Code, Codex, Microsoft Harness [BAS-01]):
  - streaming,
  - interrupt and steer mid-turn,
  - plan mode,
  - todo list display,
  - approvals UI,
  - diff view,
  - rewind/checkpoints,
  - session resume and fork,
  - headless/CI mode with JSON output,
  - background tasks with notifications.

## E. Tool / interface design
See Ch. 06. The key principle: **design tools for agents, not for developers** [MCP-05, OTH-08]:
- high-level actions,
- concise outputs with pagination,
- actionable errors,
- edit tools that fail loudly on ambiguous matches (unique-string replace),
- line-numbered reads.

## F. Structured output
Use provider-native constrained decoding (JSON schema) for structured responses and strict tool inputs where available [OTH-14, OTH-15]. Otherwise validate and repair (re-ask with the validation error). Constrained decoding is also what makes small or local models usable for tool calling [PERF-05].

## G. Durability & ops
- Event-sourced sessions (append-only log), crash-safe resume, idempotent tool replays where possible.
- Long tasks: checkpoints, budgets, heartbeats, background execution [OTH-12, AGT-15].
- Configuration layering: enterprise → user → project → local, with managed policy that users cannot override (permissions, allowed MCP servers).
- Versioning of prompts, skills and tool definitions (Ch. 04) for reproducibility.

## H. Harness basics & reference designs (from your sheet)
- **Microsoft Agent Framework Harness** [BAS-01] is the most complete published reference: chat client → pipeline (function loop, per-call history persistence, compaction) → context providers (instructions, tools, memory, todos, plan/execute modes, skills) → middleware (approvals, OTel, bounded looping) → UX. Its capability matrix is a good feature checklist: function invocation limits, compaction, todos, modes, file memory, tool approval with standing rules, OTel, web search, skills, background agents, shell, looping.
- **Databricks** [BAS-02]: agent = model + harness; most production failures are harness failures.
- **codecentric** [BAS-03]: context engineering ⊂ harness engineering ⊂ loop engineering. Loops amplify weaknesses in the lower layers, so build bottom-up.

<!-- SOURCES:OTH,BAS -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| BAS-01 | [Agent Harness (Microsoft Agent Framework)](https://learn.microsoft.com/en-us/agent-framework/concepts/harness) | Microsoft | 2026-10-23 | Must read |
| BAS-02 | [What is an AI Agent Harness?](https://www.databricks.com/blog/ai-harness) | Databricks | 2026 | Should read |
| BAS-03 | [Loop Engineering, Harness Engineering, Context Engineering: what's the difference?](https://www.codecentric.de/en/knowledge-hub/blog/loop-harness-context-engineering-explained) | codecentric (Benjamin Font Pera) | 2026-07-05 | Should read |
| OTH-01 | [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/) | Simon Willison | 2025-06-16 | Must read |
| OTH-02 | [Defeating Prompt Injections by Design (CaMeL)](https://arxiv.org/abs/2503.18813) | Debenedetti et al. (Google DeepMind, ETH) | 2025-03-24 | Should read |
| OTH-03 | [Design Patterns for Securing LLM Agents against Prompt Injections](https://arxiv.org/abs/2506.08837) | Beurer-Kellner et al. | 2025-06-10 | Must read |
| OTH-04 | [Beyond permission prompts: making Claude Code more secure and autonomous (sandboxing)](https://www.anthropic.com/engineering/claude-code-sandboxing) | Anthropic | 2025-10-20 | Must read |
| OTH-05 | [OWASP Top 10 for Agentic Applications (2026)](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/) | OWASP GenAI Security Project | 2025-12-09 | Must read |
| OTH-06 | [OWASP Top 10 for LLM Applications (2025)](https://genai.owasp.org/llm-top-10/) | OWASP GenAI Security Project | 2024-11 | Should read |
| OTH-07 | [OpenTelemetry semantic conventions for GenAI agent spans](https://opentelemetry.io/docs/specs/semconv/gen-ai/gen-ai-agent-spans/) | OpenTelemetry | current | Must read |
| OTH-08 | [SWE-agent: Agent-Computer Interfaces Enable Automated Software Engineering](https://arxiv.org/abs/2405.15793) | Yang et al. (Princeton) | 2024-05-06 | Must read |
| OTH-09 | [SWE-bench: Can LMs Resolve Real-World GitHub Issues?](https://arxiv.org/abs/2310.06770) | Jimenez et al. (Princeton) | 2023-10-10 | Should read |
| OTH-10 | [tau-bench: Tool-Agent-User Interaction in Real-World Domains](https://arxiv.org/abs/2406.12045) | Yao et al. (Sierra) | 2024-06-17 | Should read |
| OTH-11 | [Terminal-Bench: Benchmarking Agents on Hard, Realistic CLI Tasks](https://arxiv.org/abs/2601.11868) | Terminal-Bench team (Stanford, Laude Institute) | 2026-01-17 | Must read |
| OTH-12 | [Measuring AI Ability to Complete Long Tasks](https://arxiv.org/abs/2503.14499) | METR | 2025-03-18 | Should read |
| OTH-13 | [AG-UI (Agent-User Interaction Protocol)](https://docs.ag-ui.com) | CopilotKit + community | 2025 / current | Optional |
| OTH-14 | [Structured outputs (Claude)](https://docs.claude.com/en/docs/build-with-claude/structured-outputs) | Anthropic | 2025-11 / current | Should read |
| OTH-15 | [Introducing Structured Outputs in the API](https://openai.com/index/introducing-structured-outputs-in-the-api/) | OpenAI | 2024-08-06 | Optional |
<!-- /SOURCES -->
