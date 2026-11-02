# 06 — Plugins, MCP & interoperability protocols

## The protocol map
| Protocol | Connects | Status | Sources |
|----------|----------|--------|---------|
| **MCP** (Model Context Protocol) | Agent ↔ tools/data (tools, resources, prompts, sampling, elicitation) | De-facto standard; donated to the Linux Foundation's **Agentic AI Foundation** (Dec 2025) alongside AGENTS.md and goose | MCP-01, MCP-02, MCP-07 |
| **A2A** (Agent2Agent) | Agent ↔ remote agent (Agent Cards, tasks, streaming) | Google-originated, now a Linux Foundation project | MCP-08, MCP-09 |
| **ACP** (Agent Client Protocol) | Editor/IDE ↔ coding agent | Zed-originated; used by Zed, JetBrains, Gemini CLI, Claude Code via adapter | MCP-12 |
| **AG-UI** | Agent backend ↔ web front-end (event stream) | Community (CopilotKit) | OTH-13 |
| Agent Skills / AGENTS.md | Guidance files | Open specs | SKL-02, SKL-07 |

A complete harness is an **MCP client** (consumes tools), optionally an **ACP agent** (so editors can drive it) and an **A2A server/client** (for remote delegation). It also has its own **plugin system** that packages everything.

## MCP essentials for implementers [MCP-01, MCP-02]
- Transports: **stdio** (local subprocess) and **streamable HTTP** (remote). Auth for remote servers is OAuth 2.1-based. The 2025-11-25 revision added OIDC discovery, incremental scope consent and Client ID Metadata Documents.
- Server features: `tools`, `resources` (readable context, subscriptions), `prompts` (templates → slash commands).
- Client features: `sampling` (server asks the client's model to generate), `elicitation` (server asks the user for input), `roots`.
- `list_changed` notifications. Tools can change at runtime, so pair this with cache-stable handling (append, don't reorder).
- **Tasks** (experimental in 2025-11-25): call-now/fetch-later for long operations, now being moved into an extension. Isolate version handling.
- Registry: an official metadata registry for discovering servers [MCP-13].

## The context-cost problem and its fixes
Loading every MCP tool definition up front can consume tens of thousands of tokens, and chaining tools pipes large intermediate results through the model. Three fixes have emerged:
1. **Tool search / deferred loading.** Only a search tool and a few core tools are loaded; definitions are fetched on demand. Opus 4.5 went from 79.5% to 88.1% on MCP evals with it enabled [MCP-04].
2. **Code execution with MCP / "Code Mode".** Expose MCP servers as a code API (e.g. a TypeScript module tree) inside a sandbox. The agent writes code that calls tools, filters results and only prints what matters. Anthropic's example went from 150k to 2k tokens [MCP-03]; Cloudflare reached the same conclusion independently [MCP-06].
3. **Programmatic tool calling and tool use examples.** The model calls tools from code without each result entering context, and tool definitions include example calls for correct usage [MCP-04].

## Tool design (applies to built-in and MCP tools) [MCP-05, OTH-08]
- Prefer **fewer, higher-level tools** that match real workflows (`schedule_event`, not `list_users` + `list_events` + `create_event`).
- **Namespace** tools (`github_issues_search`) to avoid confusion across servers.
- Return **meaningful, token-efficient** results: human-readable IDs, `response_format: concise|detailed`, pagination, truncation with hints.
- Write **actionable errors** ("file not found; did you mean …").
- Tool descriptions are prompts. Evaluate them with agents.

## Security: MCP is a supply chain [MCP-10, OTH-01, OTH-05]
- **Tool poisoning**: hidden instructions in tool descriptions (any schema field) can make the agent read `~/.ssh/id_rsa` and exfiltrate it.
- **Shadowing**: a malicious server's description changes behaviour of *another* server's tools.
- **Rug pulls**: a definition changes after approval.
- Mitigations:
  - show full tool descriptions on install;
  - **pin and hash definitions** and alert on change;
  - per-server permission scopes;
  - run local servers sandboxed;
  - network egress allow-list;
  - treat all tool output as untrusted (taint tracking, Ch. 09).

## Plugins [MCP-11]
Claude Code's plugin model is a good template. A plugin is a directory with `.claude-plugin/plugin.json` that can bundle:
- slash commands,
- subagents,
- skills,
- hooks,
- MCP server configs.

A **marketplace** is just a git repo (or URL) containing `.claude-plugin/marketplace.json` that lists plugins. Install/enable/disable happens per user or project. This gives distribution without running a central store.

## Recommendations for our harness
1. **Full MCP client**:
   - stdio + streamable HTTP; OAuth with token storage in the OS keychain;
   - tools / resources / prompts / sampling / elicitation;
   - `list_changed`;
   - per-server enable/disable and allowlists.
2. **Tool registry** that unifies built-in, MCP and plugin tools, with metadata: read-only?, destructive?, concurrency-safe?, network?, approval policy. This feeds the permission engine and the parallel executor.
3. **Deferred tools + `tool_search`** when total definitions exceed a token threshold [MCP-04].
4. **Optional code-execution mode** that generates a typed API for connected MCP servers inside the sandbox [MCP-03].
5. **Security**: definition hashing and change alerts, an install-time review screen, sandboxed stdio servers, egress allow-list.
6. **Plugin format compatible with Claude Code's** (commands, agents, skills, hooks, MCP), with git-repo marketplaces. Compatibility gives users an existing ecosystem on day one.
7. **ACP server mode** so the harness runs inside Zed and JetBrains; A2A later for remote agents.
8. **Tool-design lint** for built-in tools against the guidelines above.

## Open questions
- Do we support MCP `sampling`, letting servers spend the user's tokens? Default off with a prompt.
- Plugin trust: signatures? A curated default marketplace?

<!-- SOURCES:MCP -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| MCP-01 | [Model Context Protocol specification (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25) | MCP / Agentic AI Foundation | 2025-11-25 | Must read |
| MCP-02 | [MCP 2025-11-25 changelog](https://modelcontextprotocol.io/specification/2025-11-25/changelog) | MCP | 2025-11-25 | Should read |
| MCP-03 | [Code execution with MCP: building more efficient agents](https://www.anthropic.com/engineering/code-execution-with-mcp) | Anthropic | 2025-11-04 | Must read |
| MCP-04 | [Introducing advanced tool use (Tool Search, Programmatic Tool Calling, Tool Use Examples)](https://www.anthropic.com/engineering/advanced-tool-use) | Anthropic | 2025-11-20 | Must read |
| MCP-05 | [Writing effective tools for agents — with agents](https://www.anthropic.com/engineering/writing-tools-for-agents) | Anthropic | 2025-09-11 | Must read |
| MCP-06 | [Code Mode: the better way to use MCP](https://blog.cloudflare.com/code-mode/) | Cloudflare | 2025-09 | Should read |
| MCP-07 | [Linux Foundation announces the Agentic AI Foundation (AAIF)](https://www.linuxfoundation.org/press/linux-foundation-announces-the-formation-of-the-agentic-ai-foundation) | Linux Foundation | 2025-12-09 | Should read |
| MCP-08 | [Announcing the Agent2Agent Protocol (A2A)](https://developers.googleblog.com/en/a2a-a-new-era-of-agent-interoperability/) | Google | 2025-04-09 | Should read |
| MCP-09 | [A2A protocol specification](https://a2a-protocol.org) | Linux Foundation (A2A project) | current | Optional |
| MCP-10 | [MCP Security Notification: Tool Poisoning Attacks](https://invariantlabs.ai/blog/mcp-security-notification-tool-poisoning-attacks) | Invariant Labs | 2025-04 | Must read |
| MCP-11 | [Customize Claude Code with plugins](https://www.anthropic.com/news/claude-code-plugins) | Anthropic | 2025-10 | Must read |
| MCP-12 | [Agent Client Protocol (ACP)](https://agentclientprotocol.com) | Zed Industries | 2025-08 / current | Should read |
| MCP-13 | [MCP Registry](https://registry.modelcontextprotocol.io) | MCP | 2025-09 / current | Optional |
| MCP-14 | [Apps SDK (built on MCP)](https://developers.openai.com/apps-sdk) | OpenAI | 2025-10 / current | Optional |
<!-- /SOURCES -->
