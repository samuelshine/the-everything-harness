# 08 — Agent creation & task delegation

## Start from the patterns [AGT-01]
Anthropic distinguishes **workflows** (LLMs orchestrated through predefined code paths) from **agents** (the LLM directs its own process and tool use). Five composable workflow patterns:

| Pattern | Use when |
|---------|----------|
| Prompt chaining | Task splits into fixed sequential steps with checks between them |
| Routing | Inputs fall into distinct categories with different handling or models |
| Parallelization (sectioning / voting) | Independent subtasks, or multiple attempts for confidence |
| Orchestrator–workers | Subtasks aren't known in advance; a lead decomposes dynamically |
| Evaluator–optimizer | Clear evaluation criteria and iterative improvement pays off |

Guidance: start with the simplest thing; add agency only when it measurably helps. Invest in the agent-computer interface (tools) as much as in prompts.

The core agent loop is the same across vendors: **gather context → take action → verify → repeat** [AGT-07]. In Codex, tool output is appended and the model is called again until it stops requesting tools [AGT-10].

## The multi-agent debate
| | For (Anthropic research system) [AGT-02] | Against / caution (Cognition) [AGT-03] |
|-|-------------------------------------------|----------------------------------------|
| Claim | Opus lead + Sonnet subagents beat single-agent Opus by 90.2% on breadth-first research | Multi-agent systems are fragile; context isn't shared well enough |
| Why | Parallel exploration, separate context windows, more total tokens (token use explains most variance) | Actions carry implicit decisions; parallel writers make conflicting choices |
| Cost | ~15x chat tokens | — |
| Fits | Read-heavy, parallelisable, exceeds one window | Tightly coupled writing (code) |

**Synthesis**: they're compatible. Use **parallel subagents for reading, research, search and verification**, and keep **one writer per artifact**. Where many writers are unavoidable, coordinate through **tests, git and locks** rather than chat. Anthropic's 16-agent C compiler had no orchestrator; agents claimed tasks via lock files in a shared repo and used a large test suite as the arbiter [AGT-09].

## Why multi-agent systems fail [AGT-04]
MAST lists 14 failure modes in 3 groups:
1. **Specification / system design**: disobeying the task or role spec, step repetition, losing conversation history, not knowing when to stop.
2. **Inter-agent misalignment**: conversation resets, failing to ask for clarification, task derailment, withholding information, ignoring other agents' input, reasoning–action mismatch.
3. **Task verification**: premature termination, no or incomplete verification, incorrect verification.

Each maps to a harness feature: structured briefs (1), shared artifacts and full-context forks (2), and evaluator roles (3).

## Delegation mechanics
| Mechanism | Description | Sources |
|-----------|-------------|---------|
| **Agents as tools** (manager pattern) | Parent calls a subagent like a tool and gets back a result | AGT-05, AGT-06 |
| **Handoffs** (decentralised) | Control transfers to another agent, which talks to the user directly | AGT-05, AGT-06 |
| **Subagents with isolated context** | Fresh window, own system prompt, tool allowlist, model; returns a condensed result | AGT-08, CTX-19 |
| **Forked subagents** | Child inherits the parent's conversation (cache reuse) | CTX-19 |
| **Workflow agents** | Deterministic sequential/parallel/loop containers around LLM agents | AGT-11 |
| **Background agents** | Long-running children; the parent continues and is notified | BAS-01 |
| **Remote agents** | A2A protocol to agents in other systems | MCP-08 |

## Writing delegation briefs [AGT-02]
Anthropic found vague subagent tasks caused duplicated work and gaps. Each brief should include:
- the **objective**,
- the **output format**,
- **which tools and sources** to use,
- **clear task boundaries** (what *not* to do),
- an **effort budget** (e.g. 3–5 tool calls for simple lookups, more for complex research).

The lead should scale the number of subagents to query complexity.

## Defining agents (file format) [AGT-08]
```markdown
---
name: code-reviewer
description: Reviews diffs for correctness and security. Use after edits.
tools: [Read, Grep, Glob, Bash(git diff:*)]
model: fast
context: isolated        # or: fork
max_turns: 30
---
You are a skeptical senior reviewer...
```
Markdown with frontmatter is portable, diffable and matches Claude Code's format.

## Durability for long tasks
METR's measured task horizon doubles roughly every 7 months [OTH-12]. Multi-hour runs need:
- checkpoints and resumability (LangGraph-style durable execution) [AGT-15];
- per-agent budgets (tokens, time, cost) and stop conditions;
- progress artifacts so a fresh agent can resume [CTX-03];
- rainbow or graceful deploys for long-running server-side agents [AGT-02].

## Recommendations for our harness
1. **Agent definition format**: markdown + frontmatter (name, description, tools, model alias, context mode, budgets, hooks). Discovered from user, project and plugin directories.
2. **`Task`/`Agent` tool**: the parent spawns a subagent with a structured brief schema (objective, deliverable format, boundaries, budget); the child returns a condensed result plus an artifact path for details.
3. **Context modes** `isolated | fork` [CTX-19]; **default isolated** for reviewers and researchers.
4. **Concurrency policy**: read-only subagents in parallel; write-capable subagents get disjoint path scopes (worktrees) or run serially.
5. **Built-in agents**: `explore` (read-only search), `plan`, `review`/`evaluator`, `general`.
6. **Workflow primitives** (sequential / parallel / loop-until-criteria) for deterministic orchestration in config or code [AGT-11].
7. **Handoff support** for conversational products, alongside agents-as-tools [AGT-05].
8. **Budgets and kill switches** per agent; parent sees child status; a tree view in the UI.
9. **MAST-based trace analyser** that flags repetition, premature termination and missing verification in logs [AGT-04].

## Open questions
- Should subagents be able to spawn subagents (depth > 1)? Cost and complexity explode. *Lean:* depth 1 by default, configurable.
- How should conflicts be merged when parallel writers are allowed? Worktrees + PR-style merge + tests [AGT-09].

<!-- SOURCES:AGT -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| AGT-01 | [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | Anthropic (Schluntz, Zhang) | 2024-12-19 | Must read |
| AGT-02 | [How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system) | Anthropic | 2025-06-13 | Must read |
| AGT-03 | [Don't Build Multi-Agents](https://cognition.ai/blog/dont-build-multi-agents) | Cognition (Walden Yan) | 2025-06-12 | Must read |
| AGT-04 | [Why Do Multi-Agent LLM Systems Fail? (MAST)](https://arxiv.org/abs/2503.13657) | Cemri et al. (UC Berkeley) | 2025-03 | Must read |
| AGT-05 | [A practical guide to building agents](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) | OpenAI | 2025-04 | Must read |
| AGT-06 | [OpenAI Agents SDK](https://openai.github.io/openai-agents-python/) | OpenAI | 2025-03 / current | Should read |
| AGT-07 | [Building agents with the Claude Agent SDK](https://www.anthropic.com/engineering/building-agents-with-the-claude-agent-sdk) | Anthropic | 2025-09-29 | Must read |
| AGT-08 | [Subagents (Claude Code)](https://docs.claude.com/en/docs/claude-code/sub-agents) | Anthropic | current | Should read |
| AGT-09 | [Building a C compiler with a team of parallel Claudes](https://www.anthropic.com/engineering/building-c-compiler) | Anthropic (Nicholas Carlini) | 2026-02 | Should read |
| AGT-10 | [Unrolling the Codex agent loop](https://openai.com/index/unrolling-the-codex-agent-loop/) | OpenAI (Michael Bolin) | 2026-01-23 | Must read |
| AGT-11 | [Agent Development Kit (ADK)](https://google.github.io/adk-docs/) | Google | 2025-04-09 / current | Should read |
| AGT-12 | [ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629) | Yao et al. (Princeton, Google) | 2022-10-06 | Optional |
| AGT-13 | [AutoGen: Next-Gen LLM Applications via Multi-Agent Conversation](https://arxiv.org/abs/2308.08155) | Wu et al. (Microsoft) | 2023-08-16 | Optional |
| AGT-14 | [MetaGPT: Meta Programming for a Multi-Agent Collaborative Framework](https://arxiv.org/abs/2308.00352) | Hong et al. | 2023-08-01 | Optional |
| AGT-15 | [LangGraph](https://langchain-ai.github.io/langgraph/) | LangChain | current | Should read |
<!-- /SOURCES -->
