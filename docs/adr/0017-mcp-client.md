# 0017 — MCP client

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/06-plugins-mcp.md`, `docs/research/10-terminal-harness.md` §9, ADR-0003, ADR-0010; sources [MCP-01], [MCP-02], [MCP-04], [MCP-10]

## Context
MCP is the standard way to give an agent tools that live outside it: GitHub, a browser, a database, a company's internal APIs [MCP-01]. Claude Code users keep their servers in `.mcp.json`, and ADR-0010 says teh reads that file as it is.

MCP servers are also a supply chain [MCP-10]:
- a project's `.mcp.json` starts arbitrary programs;
- a server's tool descriptions go straight into the model's context;
- a server tool can do anything, and teh can't see what it does.

## Options considered
1. **Official TypeScript SDK.** Complete, but it pulls in a web framework and a schema library for the server side we don't need, and it would be our first runtime dependency (ADR-0001 keeps one compiled binary small).
2. **Own minimal client** (chosen). JSON-RPC 2.0 over stdio and streamable HTTP is a few hundred lines, and we only need initialize, tools/list and tools/call to start.
3. **Wait for a plugin system** and load MCP through it. This blocks a P0 capability on a P2 one.

## Decision
**Configuration**, in Claude Code's format:
- **Files:** `.mcp.json` in the project, `~/.teh/mcp.json` for the user, and `--mcp-config <file or JSON>` (repeatable). On a name clash the later source wins (user, then project, then flag). `--strict-mcp-config` uses only the flag's servers.
- **Server types:** `{"command", "args", "env"}` for stdio; `{"type": "http", "url", "headers"}` for streamable HTTP. The legacy SSE transport is rejected with a message pointing at the HTTP endpoint.
- **Variables:** `${VAR}` and `${VAR:-default}` expand from the environment. Unset variables are reported.

**Protocol.**
- **Version:** we offer `2025-11-25` and accept whatever version the server answers with.
- **Startup:** every server starts in parallel, with a 30 s timeout (`MCP_TIMEOUT` in ms). A server that fails is reported and skipped; the run goes on without it.
- **HTTP:** we keep the `Mcp-Session-Id`, send `MCP-Protocol-Version`, read both JSON and SSE replies, and send DELETE when closing.
- **Server requests:** we answer `ping`. Other requests (sampling, elicitation, roots) get "method not found", because teh declares no client capabilities yet.
- **Interrupts:** an interrupted or timed-out call sends `notifications/cancelled`.

**Tools.** Each server tool becomes `mcp__<server>__<tool>`, Claude Code's naming, cut to 64 characters, so permission rules and hook matchers written for Claude Code work here.
- Descriptions are capped at 2,000 characters.
- Results are rendered as text. Images and audio are noted but not passed on until the item model carries them.
- Output is truncated like any tool's.
- Servers' `instructions` go into the system prompt in an `<mcp_servers>` block.

**Permissions.** An MCP tool's effects are unknown to teh, so it gets its own access kind, `external`:
- **Default:** every call asks. Headless runs therefore deny it and print the rule that would allow it.
- **Allow rules:** `mcp__github` and `mcp__github__*` allow every tool of a server; `mcp__github__search_issues` allows one tool. Deny rules win, as always.
- **`acceptEdits`** does not cover MCP tools. Editing files and calling a remote service are different risks.
- **Plan mode** denies MCP tools unless a rule allows them. A server's `readOnlyHint` is not trusted, because the server writes it.
- **No checkpoint** is taken before an MCP call, since teh can't know what it changes locally.

**Trust.** Servers from a repo's `.mcp.json` start only after `teh trust`, like project allow rules and hooks. User and flag servers always start. `teh mcp` starts every server, lists its tools, and shows which servers wait for trust.

## Consequences
- **Existing setups work:** a Claude Code user's `.mcp.json`, and their `mcp__…` permission rules, work unchanged.
- **Everything is loaded up front.** Every tool definition is in the prompt from the first turn. With many servers this costs context. Deferred loading with a tool-search tool [MCP-04] is the planned follow-up, triggered by a token threshold.
- **Not yet supported:**
  - OAuth sign-in for remote servers (a static `Authorization` header works);
  - resources and prompts;
  - sampling, elicitation and roots;
  - `list_changed` reloading (the flag is recorded, not acted on);
  - images in results;
  - the legacy SSE transport.
- **Security follow-ups:**
  - run stdio servers inside the OS sandbox (ADR-0003);
  - pin a hash of each server's tool definitions and warn when they change (the "rug pull" in doc 06);
  - show full tool descriptions when a server is first trusted.
- **Windows:** `npx` and other `.cmd` launchers may need `"command": "cmd", "args": ["/c", "npx", ...]`, as in Claude Code.
