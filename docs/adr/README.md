# Architecture decision records

Each ADR records one significant decision: its context, the options considered, the choice, and its consequences. Files are numbered `NNNN-short-title.md` and never renumbered. To change a decision, write a new ADR that supersedes the old one.

Statuses: `Proposed` → `Accepted` → (`Superseded by NNNN` | `Deprecated`).

Start from [`0000-template.md`](0000-template.md).

## Backlog (from research)
These decisions are open, with the research's current lean. Sources are in [synthesis §5](../research/00-synthesis.md#5-decisions-to-make) and [terminal harness §14](../research/10-terminal-harness.md#14-recommended-mvp-cut-maps-to-synthesis-build-order).

| ADR | Decision | Research lean |
|---|---|---|
| [0001](0001-language-runtime-and-distribution.md) (Accepted) | Language/runtime and distribution | TypeScript on Bun, compiled to a single binary; engine/TUI split with a language-neutral event protocol |
| 0002 | Provider layer: own adapters vs LiteLLM | Native Anthropic + OpenAI adapters, **plus a generic OpenAI-compatible adapter and a native Ollama adapter in the first release** (local models); capability registry seeded from models.dev; cost model per auth route (doc 12) |
| 0003 | Permission and sandbox model | Sandbox mode x approval mode, plus deny→ask→allow rules over a parsed shell AST |
| 0004 | Session storage and checkpoints | Append-only JSONL sessions, plus a shadow-git snapshot per turn |
| 0005 | TUI rendering | Inline differential renderer by default; alternate screen opt-in |
| 0006 | Memory backend | Files and grep first; pluggable store behind a memory tool |
| 0007 | Multi-agent default | Single writer; parallel subagents for read-heavy work only |
| [0008](0008-default-approval-posture.md) (Accepted) | Default approval posture | Decided: ask before every action that changes something; sandbox stays on underneath. Research had leaned towards Codex-style workspace-write |
| [0009](0009-provider-auth-and-subscriptions.md) (Accepted) | Provider authentication and subscription access | API keys everywhere; ChatGPT plan via Sign in with ChatGPT (open-source route); Claude subscriptions only through the user's own Claude Code; never reuse first-party logins |
| [0010](0010-claude-code-compatibility.md) (Accepted) | Claude Code compatibility | Mirror flags, slash commands, project files and hooks; own settings directory and branding |
| [0011](0011-telemetry.md) (Accepted) | Telemetry | Anonymous usage stats on by default; strict field allow-list; first-run notice; easy opt-out incl. `DO_NOT_TRACK` |
| 0012 | Telemetry backend | To decide before the first public release |
| 0013 | Windows sandbox | Not yet researched |
| 0014 | Model policy (routing) | Roles + task triage + escalate on failure, at task boundaries only; off by default until evals beat one mid-tier model; learned policy later (doc 12) |
