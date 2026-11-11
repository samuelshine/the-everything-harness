# Architecture decision records

Each ADR records one significant decision: its context, the options considered, the choice, and its consequences. Files are numbered `NNNN-short-title.md` and never renumbered. To change a decision, write a new ADR that supersedes the old one.

Statuses: `Proposed` → `Accepted` → (`Superseded by NNNN` | `Deprecated`).

Start from [`0000-template.md`](0000-template.md).

## Backlog (from research)
These decisions are open, with the research's current lean. Sources are in [synthesis §5](../research/00-synthesis.md#5-decisions-to-make) and [terminal harness §14](../research/10-terminal-harness.md#14-recommended-mvp-cut-maps-to-synthesis-build-order).

| ADR | Decision | Research lean |
|---|---|---|
| [0001](0001-language-runtime-and-distribution.md) (Accepted) | Language/runtime and distribution | TypeScript on Bun, compiled to a single binary; engine/TUI split with a language-neutral event protocol |
| [0002](0002-provider-layer.md) (Accepted) | Provider layer | Own thin adapters over official SDKs with an item-based model: `anthropic`, `openai` (API key + ChatGPT plan), `openai-compatible`, native `ollama`, `fake` for tests; capability registry from models.dev + probes; cost per auth route |
| [0003](0003-permission-and-sandbox-model.md) (Proposed) | Permission and sandbox model | Approval rules (Claude Code syntax) matched per parsed simple command; conservative read-only classifier; protected paths; workspace trust for project allow rules; OS sandbox (Seatbelt/bubblewrap) underneath in a follow-up |
| [0004](0004-sessions-and-checkpoints.md) (Accepted) | Session storage and checkpoints | Append-only JSONL event tree per session in `~/.teh/projects/`; shadow-git worktree snapshot per turn (covers bash); rewind asks first; 30-day retention |
| [0005](0005-tui-rendering.md) (Proposed) | TUI rendering | Own inline differential renderer, no dependencies (the default is now full screen, see 0018): finished output goes to native scrollback once, only a small live area redraws; inline approvals, Esc interrupt, queued messages, Shift+Tab modes |
| 0006 | Memory backend | Files and grep first; pluggable store behind a memory tool |
| 0007 | Multi-agent default | Single writer; parallel subagents for read-heavy work only |
| [0008](0008-default-approval-posture.md) (Accepted) | Default approval posture | Decided: ask before every action that changes something; sandbox stays on underneath. Research had leaned towards Codex-style workspace-write |
| [0009](0009-provider-auth-and-subscriptions.md) (Accepted) | Provider authentication and subscription access | API keys everywhere; ChatGPT plan via Sign in with ChatGPT (open-source route); Claude subscriptions only through the user's own Claude Code; never reuse first-party logins |
| [0010](0010-claude-code-compatibility.md) (Accepted) | Claude Code compatibility | Mirror flags, slash commands, project files and hooks; own settings directory and branding |
| [0011](0011-telemetry.md) (Accepted) | Telemetry | Anonymous usage stats on by default; strict field allow-list; first-run notice; easy opt-out incl. `DO_NOT_TRACK` |
| 0012 | Telemetry backend | To decide before the first public release |
| 0013 | Windows sandbox | Not yet researched |
| [0014](0014-model-policy.md) (Accepted) | Model policy (routing) | Roles on by default; triage and escalation opt-in until evals beat one mid-tier model; boundaries only; escalation asks first; pins win |
| [0015](0015-skills-commands-and-output-styles.md) (Proposed) | Skills, slash commands, output styles, skill routing | Agent Skills spec + Claude Code command/style files, one loader, user level wins; `/name` deterministic; `Skill` tool with a listing budget; opt-in embedding pre-router with optional small-model confirm |
| [0016](0016-hooks.md) (Proposed) | Hooks | Claude Code's command hooks and JSON I/O; a hook can block or ask freely but its allow never overrides a deny rule or plan mode; project hooks wait for `teh trust` |
| [0017](0017-mcp-client.md) (Proposed) | MCP client | Own minimal client (stdio + streamable HTTP, tools only to start); Claude Code's `.mcp.json` and `mcp__server__tool` names; every call asks unless a rule allows it; a repo's servers wait for `teh trust` |
| [0018](0018-full-screen-ui-and-session-cache.md) (Proposed) | Full-screen UI and session cache | Full screen on the alternate screen by default, `--inline` as fallback; what the UI showed is cached per session and deleted after 3 idle days (`cacheRetentionDays`); the conversation is kept, so `teh -c` still works; each directory is its own project and is asked about trust once; tool calls and diffs drawn apart from chat; tabbed settings panel; `/btw` side questions |
| [0021](0021-web-todo-notebook-tools.md) (Proposed) | Web, to-do and notebook tools | `TodoWrite` (reminded when stopping with open items; kept across compaction), `WebFetch` (Markdown, read by a helper model, untrusted marking), `WebSearch` (DuckDuckGo, SearXNG or Brave; engine set by the user only), `NotebookEdit`; a `network` access kind that asks in every mode unless `WebFetch(domain:…)` / `WebSearch` rules allow it |
| [0020](0020-context-compaction.md) (Proposed) | Context compaction | Near 75% of the window (estimate scaled by reported tokens), summarise the older part with the same model and keep recent turns verbatim; the user's prompts and changed files are added without the model; `/compact [focus]`; logged so `teh -c` continues and rewind restores the full conversation; `PreCompact` and `SessionStart` (`compact`) hooks |
| [0019](0019-explore-subagents.md) (Proposed) | Explore subagents | `Task` tool runs an isolated, read-only subagent (Read, Glob, Grep, plan-mode Bash) on the explore model; only its report returns, so searches do not grow the main context |
