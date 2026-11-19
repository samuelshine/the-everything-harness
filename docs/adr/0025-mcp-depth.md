# 0025 — MCP depth: tool search, OAuth, resources, prompts, pins and sandboxing

- **Status:** Accepted (2026-11-19, shipped)
- **Date:** 2026-11-19
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/06-plugins-mcp.md` ([MCP-04] tool search, the "rug pull" risk), ADR-0003, ADR-0017

## Context
ADR-0017 shipped tools over stdio and HTTP, then listed what was missing: every tool definition loaded up front, no OAuth, no resources or prompts, `list_changed` recorded but ignored, images dropped, and three security follow-ups (sandboxing stdio servers, pinning tool definitions, full descriptions on trust). Teams with many servers and remote servers that use OAuth could not use teh as they use Claude Code.

## Decision
- **Tool search.** When MCP tool definitions would take more than 10% of the model's context window, they are left out of the request. The model gets their names in a `<deferred_tools>` block and a `ToolSearch` tool (Claude Code's name).
  - `"select:a,b"` loads by name, and keywords rank names above descriptions.
  - Loaded tools are sent from the next request on. A deferred tool called before it is loaded still runs, since teh knows it.
  - `TEH_TOOL_SEARCH` (or Claude Code's `ENABLE_TOOL_SEARCH`) set to `on` or `off` overrides the threshold.
- **OAuth**, per the MCP authorization spec:
  - **Discovery:** the 401's `WWW-Authenticate` names the protected-resource metadata (RFC 9728), with the `.well-known` paths as fallback. That metadata names the authorization server, whose metadata comes from RFC 8414 or OpenID discovery, path-aware.
  - **Client:** dynamic client registration (RFC 7591) as a public client, or a `clientId` given in the server's config.
  - **Flow:** PKCE S256, which is required: a server that does not advertise it is refused. The `resource` parameter (RFC 8707) is sent on authorize, token and refresh requests. The redirect is a loopback URL on a fixed port, reused because registered redirects must match exactly.
  - **Storage:** tokens go in the OS secret store, and the registration in `~/.teh/auth/mcp/`. Tokens are refreshed a minute before expiry; a refused refresh clears them.
  - **Commands:** `teh mcp login|logout <server>`. Client ID metadata documents (the 2025-11-25 alternative to registration) are not used, since they need a hosted HTTPS URL.
- **Resources** are reached through `ListMcpResourcesTool` and `ReadMcpResourceTool` (Claude Code's names). They are `external` access, so they ask like other MCP calls.
- **Prompts** become commands, `/mcp__<server>__<prompt>`, in the UI and `teh -p`. Arguments are given in order and the last takes the rest of the line.
- **Roots:** the client declares `roots` and answers `roots/list` with the working folder. Sampling and elicitation are still refused with "method not found": both put a server in control of the model or the user, and need their own design.
- **`list_changed`:** before each model request the agent asks for fresh tools. Servers that sent the notification are listed again, and the new tools replace the old ones (re-split for tool search).
- **Images** in tool results and image blobs in resources are passed to models with vision. The text says the image is attached.
- **Fingerprints ("rug pull").** A hash of each server's tool names, descriptions and schemas is saved on first use in `~/.teh/mcp-pins.json`. A change is reported on every start and in `teh mcp` until the user accepts it with `teh mcp pin <server|all>`. It warns and does not block: servers change their tools on ordinary upgrades, and a block would train people to accept without looking.
- **Sandbox:** `"sandbox": true` on a stdio server starts it through the OS sandbox at workspace-write, with network as the sandbox policy allows. It is opt-in because many servers write outside the workspace (caches, browser profiles). Where no sandbox is available, teh warns and runs the server without one.

## Consequences
- The agent's tool list can now change during a run, and the system prompt may carry a deferred-tools list. Both are rebuilt only between requests, so a request is always consistent.
- `teh mcp login` opens a listener on 127.0.0.1:33418 (or any free port, which then needs a new registration).
- **Still open:** sampling and elicitation; showing full tool descriptions at `teh trust` time; CIMD client ids; a live interop run against public servers (the tests use a spec-shaped fixture and fake OAuth endpoints).
