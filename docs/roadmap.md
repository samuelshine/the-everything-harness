# Roadmap

Where `teh` stands against the build order in [synthesis §4](research/00-synthesis.md#4-suggested-build-order), and what comes next. Milestones are worked in order; each lands as one or more PRs that link their ADR. The task-level breakdown, and where work stopped, is in [TASKS.md](../TASKS.md).

*Last updated: 2026-11-19.*

## Done
| Phase | What shipped |
|---|---|
| 2 Core loop and tools | Read, Write, Edit, Glob, Grep, Bash (with background shells), TodoWrite, WebFetch, WebSearch, NotebookEdit, ExitPlanMode; images and PDFs in Read; JSONL sessions; headless `-p` |
| 2b TUI v1 | Full screen and `--inline`, approvals, queueing, modes, settings panel, `/btw`, diffs |
| 3 Context engine | AGENTS.md and CLAUDE.md, automatic and manual compaction |
| 4 Sandbox and permissions | Parsed shell rules, trust, protected paths, Seatbelt and bubblewrap |
| 5 Extensions | Hooks, MCP client (stdio and HTTP), skills and commands, output styles, skill router |
| 6 Subagents (part) | Read-only explore subagents |

## Milestones
| | Milestone | Contents |
|---|---|---|
| M0 | Housekeeping | Accept shipped ADRs; usage docs out of the README; this roadmap |
| M1 | Providers ([ADR-0002](adr/0002-provider-layer.md), [ADR-0009](adr/0009-provider-auth-and-subscriptions.md)) | `openai-compatible`, `anthropic`, `openai` adapters; capability registry; cost per auth route; Sign in with ChatGPT; Claude through the user's own Claude Code |
| M2 | Measurement (phase 0) | Shared eval runner with pass^k; OpenTelemetry GenAI spans; cost ledger; a Terminal-Bench style task set |
| M3 | Interactive parity ([ADR-0005](adr/0005-tui-rendering.md) "not yet") | `@file`, `!` shell mode, Ctrl+R history, Ctrl+G editor, `/resume` and `/rewind` pickers, OSC 8 and OSC 52 |
| M4 | Extension depth ([ADR-0016](adr/0016-hooks.md), [ADR-0017](adr/0017-mcp-client.md)) | MCP tool search, resources and prompts, `list_changed`, tool-definition pinning; prompt and HTTP hooks, `SubagentStop`; plugins |
| M5 | Delegation (ADR-0007) | Agent definitions, general subagents with an isolated worktree, a verifier role |
| M6 | Memory (ADR-0006) | Files first behind a memory tool |
| M7 | Release | Telemetry (ADR-0011, ADR-0012), Windows sandbox (ADR-0013), binaries and install, changelog |
| M8 | Research features (phase 8) | Prompt optimiser over traces, learned routing, long-term memory store |
