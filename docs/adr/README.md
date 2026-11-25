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
| [0003](0003-permission-and-sandbox-model.md) (Accepted) | Permission and sandbox model | Approval rules (Claude Code syntax) matched per parsed simple command; conservative read-only classifier; protected paths; workspace trust for project allow rules; OS sandbox (Seatbelt/bubblewrap) underneath |
| [0004](0004-sessions-and-checkpoints.md) (Accepted) | Session storage and checkpoints | Append-only JSONL event tree per session in `~/.teh/projects/`; shadow-git worktree snapshot per turn (covers bash); rewind asks first; 30-day retention |
| [0005](0005-tui-rendering.md) (Accepted) | TUI rendering | Own inline differential renderer, no dependencies (the default is now full screen, see 0018): finished output goes to native scrollback once, only a small live area redraws; inline approvals, Esc interrupt, queued messages, Shift+Tab modes |
| 0006 | Memory backend | Files and grep first; pluggable store behind a memory tool |
| 0007 | Multi-agent default | Single writer; parallel subagents for read-heavy work only |
| [0008](0008-default-approval-posture.md) (Accepted) | Default approval posture | Decided: ask before every action that changes something; sandbox stays on underneath. Research had leaned towards Codex-style workspace-write |
| [0009](0009-provider-auth-and-subscriptions.md) (Accepted) | Provider authentication and subscription access | API keys everywhere; ChatGPT plan via Sign in with ChatGPT (open-source route); Claude subscriptions only through the user's own Claude Code; never reuse first-party logins |
| [0010](0010-claude-code-compatibility.md) (Accepted) | Claude Code compatibility | Mirror flags, slash commands, project files and hooks; own settings directory and branding |
| [0011](0011-telemetry.md) (Accepted) | Telemetry | Anonymous usage stats on by default; strict field allow-list; first-run notice; easy opt-out incl. `DO_NOT_TRACK` |
| 0012 | Telemetry backend | To decide before the first public release |
| 0013 | Windows sandbox | Not yet researched |
| [0014](0014-model-policy.md) (Accepted) | Model policy (routing) | Roles on by default; triage and escalation opt-in until evals beat one mid-tier model; boundaries only; escalation asks first; pins win |
| [0015](0015-skills-commands-and-output-styles.md) (Accepted) | Skills, slash commands, output styles, skill routing | Agent Skills spec + Claude Code command/style files, one loader, user level wins; `/name` deterministic; `Skill` tool with a listing budget; opt-in embedding pre-router with optional small-model confirm |
| [0016](0016-hooks.md) (Accepted) | Hooks | Claude Code's command hooks and JSON I/O; a hook can block or ask freely but its allow never overrides a deny rule or plan mode; project hooks wait for `teh trust` |
| [0017](0017-mcp-client.md) (Accepted) | MCP client | Own minimal client (stdio + streamable HTTP, tools only to start); Claude Code's `.mcp.json` and `mcp__server__tool` names; every call asks unless a rule allows it; a repo's servers wait for `teh trust` |
| [0018](0018-full-screen-ui-and-session-cache.md) (Accepted) | Full-screen UI and session cache | Full screen on the alternate screen by default, `--inline` as fallback; what the UI showed is cached per session and deleted after 3 idle days (`cacheRetentionDays`); the conversation is kept, so `teh -c` still works; each directory is its own project and is asked about trust once; tool calls and diffs drawn apart from chat; tabbed settings panel; `/btw` side questions |
| [0022](0022-shells-plan-media.md) (Accepted) | Background shells, ExitPlanMode, images and PDFs | `Bash` `run_in_background` + `BashOutput`/`KillShell` with a per-session registry killed on exit; `ExitPlanMode` asks the user and switches the run's mode; `Read` sends images to vision models and reads PDFs through `pdftotext` |
| [0023](0023-measurement.md) (Accepted) | Measurement | Shared eval runner reporting pass^k; a Terminal-Bench-style task set; OpenTelemetry GenAI spans with no content, off unless configured; a local cost ledger and `teh usage` |
| [0024](0024-interactive-parity.md) (Accepted) | Interactive parity | `@path` attaches files (deny rules apply), `!` runs in your shell and goes with the next prompt, Ctrl+R/Ctrl+G/Ctrl+V, `/resume` and `/rewind` pickers, OSC 8 links and OSC 52 copy |
| [0025](0025-mcp-depth.md) (Accepted) | MCP depth | Tool search for many tools; OAuth sign-in (`teh mcp login`); resources, prompts and roots; `list_changed`; images; tool-definition fingerprints; opt-in sandbox for stdio servers |
| [0026](0026-plugins.md) (Accepted) | Plugins | Claude Code's plugin layout installed into `~/.teh/plugins/` from a directory, a git URL or `name@marketplace`; installing shows the contents and needs `--yes` or a yes; plugin hooks and MCP servers are user level; `${CLAUDE_PLUGIN_ROOT}`; `/name` and `/plugin:name`; agents recorded until M5 |
| [0021](0021-web-todo-notebook-tools.md) (Accepted) | Web, to-do and notebook tools | `TodoWrite` (reminded when stopping with open items; kept across compaction), `WebFetch` (Markdown, read by a helper model, untrusted marking), `WebSearch` (DuckDuckGo, SearXNG or Brave; engine set by the user only), `NotebookEdit`; a `network` access kind that asks in every mode unless `WebFetch(domain:…)` / `WebSearch` rules allow it |
| [0020](0020-context-compaction.md) (Accepted) | Context compaction | Near 75% of the window (estimate scaled by reported tokens), summarise the older part with the same model and keep recent turns verbatim; the user's prompts and changed files are added without the model; `/compact [focus]`; logged so `teh -c` continues and rewind restores the full conversation; `PreCompact` and `SessionStart` (`compact`) hooks |
| [0019](0019-explore-subagents.md) (Accepted) | Explore subagents | `Task` tool runs an isolated, read-only subagent (Read, Glob, Grep, plan-mode Bash) on the explore model; only its report returns, so searches do not grow the main context |
