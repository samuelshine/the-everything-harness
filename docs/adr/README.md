# Architecture decision records

Each ADR records one significant decision: its context, the options considered, the choice, and its consequences. Files are numbered `NNNN-short-title.md` and never renumbered. To change a decision, write a new ADR that supersedes the old one.

Statuses: `Proposed` → `Accepted` → (`Superseded by NNNN` | `Deprecated`).

Start from [`0000-template.md`](0000-template.md).

## Backlog (from research)
These decisions are open, with the research's current lean. Sources are in [synthesis §5](../research/00-synthesis.md#5-decisions-to-make) and [terminal harness §14](../research/10-terminal-harness.md#14-recommended-mvp-cut-maps-to-synthesis-build-order).

| ADR | Decision | Research lean |
|---|---|---|
| [0001](0001-language-runtime-and-distribution.md) (Proposed) | Language/runtime and distribution | TypeScript on Bun, compiled to a single binary; engine/TUI split with a language-neutral event protocol |
| 0002 | Provider layer: own adapters vs LiteLLM | Native adapters for the top 2–3 providers, plus a gateway adapter for the long tail |
| 0003 | Permission and sandbox model | Sandbox mode x approval mode, plus deny→ask→allow rules over a parsed shell AST |
| 0004 | Session storage and checkpoints | Append-only JSONL sessions, plus a shadow-git snapshot per turn |
| 0005 | TUI rendering | Inline differential renderer by default; alternate screen opt-in |
| 0006 | Memory backend | Files and grep first; pluggable store behind a memory tool |
| 0007 | Multi-agent default | Single writer; parallel subagents for read-heavy work only |
| 0008 | Default approval posture | Sandboxed workspace-write; prompt only for escapes |
| [0009](0009-provider-auth-and-subscriptions.md) (Proposed) | Provider authentication and subscription access | API keys everywhere; ChatGPT plan via Sign in with ChatGPT (open-source route); Claude subscriptions only through the user's own Claude Code; never reuse first-party logins |
