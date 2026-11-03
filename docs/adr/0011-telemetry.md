# 0011 — Telemetry

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/09-other-topics.md` (observability), `docs/research/10-terminal-harness.md` §12

## Context
We need to know which features are used, where sessions fail, and whether defaults such as ADR-0008 work. Developer tools are judged harshly on privacy. Accidentally collecting prompts, code or paths would destroy trust in an open-source agent, so the rules must be strict and visible.

This ADR covers **product usage statistics** sent to the project. It is separate from the user's own **observability**: OpenTelemetry traces the user sends to their own collector, which is always off unless they configure it.

## Decision
Anonymous usage statistics are **on by default**, under these rules.

1. **What is sent:** coarse, non-identifying events only:
   - `teh` version, OS and architecture, and terminal type;
   - which features ran (mode, slash command names, built-in tool names, counts of MCP servers, skills and subagents);
   - provider and model id;
   - auth route (API key, ChatGPT plan, or delegated);
   - turn and session counts, durations, token and cost totals;
   - approval-prompt outcomes (approved / denied / always-allowed, by tool type);
   - error *classes*.
2. **Never sent:** prompts, model output, code, file contents, file or directory names, repo names or URLs, shell commands or their arguments, MCP server names or URLs, environment variables, API keys, account emails, IP-derived location, or error messages that could contain any of these.
3. **Identity:** a random install id generated locally (UUIDv4 in `~/.teh/`), not derived from hardware, user or account. `teh telemetry reset` regenerates it.
4. **Notice:** on first run, a single-line notice before any event is sent, saying what is collected and how to turn it off, with a link to the event list.
5. **Opt-out:** any one of these turns it off, and the most restrictive setting wins:
   - `teh telemetry off`;
   - `"telemetry": false` in settings, including managed settings, so organisations can enforce it;
   - `TEH_TELEMETRY=0`;
   - the cross-tool `DO_NOT_TRACK=1`.

   It is also off automatically when `CI` is set, and in **local-only mode** (`--local-only`, research doc 12 §4), whose promise is no network traffic beyond local model endpoints (decided 2026-11-03).
6. **Transparency:**
   - every event type and field is listed in `docs/telemetry.md`;
   - the schema lives in code, and a test fails if an event carries a field that is not in the documented list;
   - `teh telemetry show` prints exactly what would be sent;
   - the sending code is in the open-source repo.
7. **Never in the way:** events are batched and sent in the background with a short timeout. Failures are dropped silently and never retried in a loop. With no network, `teh` behaves identically.

## Consequences
- **We must build:** the event schema and allow-list test, the batching sender, the notice, and the `teh telemetry` subcommands. Telemetry ships in the same release as the first public build, or not at all, so there is never an un-noticed version.
- **The collection backend is not chosen yet** (self-hosted PostHog, an OpenTelemetry collector, or similar). It needs its own short ADR before the first public release, covering hosting, retention (proposed: 12 months), access, and who can see the data.
- **Legal:** even anonymous data needs a privacy notice. Publish one with the first release. Install ids are pseudonymous, so we honour deletion requests by id.
- **Revisit when** users or contributors object, or a hosted version adds accounts. Account-linked analytics need a separate opt-in, never this default.
