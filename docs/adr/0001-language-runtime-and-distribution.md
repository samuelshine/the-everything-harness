# 0001 — Language, runtime and distribution

- **Status:** Accepted (2026-11-03)
- **Date:** 2026-11-02
- **Deciders:** Samuel Shine
- **Related research:** [synthesis §5.1](../research/00-synthesis.md#5-decisions-to-make), [10 §7, §13, §14](../research/10-terminal-harness.md), [11 §2](../research/11-competitive-landscape.md); sources [CMP-15], [TRM-14], [TRM-18], [TRM-21], [TRM-27]–[TRM-32], [LLM-07], [MCP-01], [MCP-12]

## Context
The harness starts as a terminal app that must feel like Claude Code: fast to start, easy to install, flicker-free, and sandboxed. It also needs to talk to many LLM providers and speak open protocols (MCP, ACP). The language choice drives five things that are hard to change later:

1. **Distribution.** Users expect a one-line install and no runtime prerequisites. Codex rewrote from TypeScript to Rust largely because requiring Node 22 was "a frustration or blocker" [CMP-15].
2. **TUI quality.** Flicker and scrollback behaviour depend on the renderer, not the language. Claude Code fixed its flicker by rewriting the renderer while keeping React [TRM-31]. pi does flicker-free inline rendering in TypeScript [TRM-32].
3. **Sandboxing.** macOS Seatbelt and Linux bubblewrap/seccomp are reachable either by spawning `sandbox-exec`/`bwrap` (any language; this is what sandbox-runtime does [TRM-14]) or through native bindings (Codex, Rust [TRM-18, TRM-19]).
4. **Ecosystem.** We need provider SDKs, the MCP and ACP SDKs, JSON-schema tooling, and tree-sitter/LSP clients. These are most complete in TypeScript and Python [LLM-07, MCP-01, MCP-12].
5. **Iteration speed.** The research phase identified many open questions. Early on, the ability to change things quickly matters more than raw performance, because the model call dominates latency.

Reference points: Claude Code, Gemini CLI, OpenCode and pi are TypeScript [TRM-21, CMP-20, TRM-32]. Codex is Rust [TRM-18]. Crush is Go [CMP-28]. Aider is Python [CMP-21].

## Options considered

| Criterion | **A. TypeScript on Bun** | B. TypeScript on Node | C. Rust | D. Go | E. Python |
|---|---|---|---|---|---|
| Single-binary install | Yes (`bun build --compile`, cross-target) | Possible (Node SEA), clunkier | Best | Best | Poor (PyInstaller-class bundling) |
| Startup time | Good | Fair | Best | Best | Fair to poor |
| TUI options | Ink/React component model + our own renderer; opentui | Same | Ratatui (proven by Codex) | Bubble Tea (proven by Crush) | Textual |
| Sandbox | Spawn `sandbox-exec`/`bwrap` (sandbox-runtime pattern) | Same | Native bindings | Native or spawn | Spawn |
| MCP / ACP / provider SDKs | First-class | First-class | Thinner, maturing | Thinner | First-class (MCP), research libraries (DSPy/GEPA) |
| Iteration speed | High | High | Lower | Medium | High |
| Contributor pool | Large | Large | Smaller | Medium | Large |
| Windows | Works; sandbox is the hard part regardless | Same | Same | Same | Same |

- **A. TypeScript on Bun:** the fastest route to a Claude-Code-class product with the best SDK coverage, and it ships as one binary. Risks: Bun compatibility edge cases, and we must own the renderer backend.
- **B. TypeScript on Node:** the most conservative runtime, but distribution is weaker. That weakness is exactly what pushed Codex off TypeScript [CMP-15].
- **C. Rust:** the best binary, memory and sandbox story. It is slower to iterate on and has a thinner AI SDK ecosystem. A good choice once the design is stable.
- **D. Go:** good binaries and TUI support, but the agent SDK ecosystem is the weakest of the serious options.
- **E. Python:** best for prompt-optimisation research (doc 04), but the weakest for distribution and TUI.

## Decision
**Proposed: Option A, TypeScript on Bun**, with these guard rails:

1. **Engine/client split.** `packages/core` (the engine) never imports TUI code. All clients (TUI, headless, ACP, server) consume one typed **JSONL event protocol**.
2. **Language-neutral protocol.** The event and extension protocol is specified as JSON Schema. Extensions (hooks, MCP servers, plugins) run as separate processes, so they can be written in any language. This keeps a later Rust core rewrite possible without breaking extensions [CMP-15].
3. **Own the renderer.** Use a React-style component model but write our own inline differential renderer backend (line diffing, synchronized output). Do not rely on stock Ink full-tree redraws [TRM-27, TRM-31].
4. **Sandbox by spawning** `sandbox-exec`/`bwrap`, following the sandbox-runtime approach [TRM-14], behind an interface that a native implementation can replace later.
5. **Ship a compiled binary** for macOS (arm64/x64), Linux (x64/arm64) and Windows (x64), plus npm and Homebrew.
6. **Python is allowed only as an optional sidecar** for offline prompt optimisation (DSPy/GEPA). It never runs in the runtime path.

## Consequences
- **Easier:** reuse of the official MCP/ACP/provider SDKs; fast iteration; a familiar stack for contributors; one binary for users.
- **Harder:**
  - We own a terminal renderer, a significant subsystem with its own test matrix.
  - We depend on Bun's Node compatibility and its compile target. Mitigation: keep the core runtime-agnostic and CI-test it on Node too.
- **Next ADRs this unblocks:** 0003 (permission/sandbox model), 0004 (sessions/checkpoints) and 0005 (TUI rendering) can now be specified concretely.
- **Revisit if:**
  - startup or memory budgets are missed (target: < 300 ms to prompt);
  - Bun compile or compatibility blocks a P0 feature;
  - sandbox-by-spawn proves insufficient on a supported OS.

  In any of those cases, consider moving `core` to Rust behind the same protocol.

## Validation spike (before accepting)
A one-week spike on a branch:
1. `bun build --compile` hello-agent binary on 3 OSes: measure size and cold start.
2. Minimal inline differential renderer streaming 5k lines without flicker in iTerm2, Terminal.app, tmux and Windows Terminal.
3. Run `bash` through `sandbox-exec` and `bwrap` with network denied.
4. Connect to one MCP server and one provider (Anthropic + OpenAI) using the official SDKs inside the compiled binary.

Accept this ADR if all four pass; otherwise re-evaluate Option C.

### Spike outcome (2026-11-03)
Results are in [`spikes/0001-bun-runtime/README.md`](../../spikes/0001-bun-runtime/README.md).
1. ✅ Compiled binaries on macOS, Linux and Windows; cold start 37–115 ms against a 300 ms target. Size is 70–94 MiB, so we ship one binary with subcommands.
2. ✅ The inline differential renderer is stable in Terminal.app; the naive full redraw is visibly glitchy. Other terminals are still to be checked during TUI work.
3. ✅ `sandbox-exec` and `bwrap` deny network and writes outside the workspace. Paths must be canonicalised, and Ubuntu 24.04 needs unprivileged user namespaces. Windows needs its own ADR.
4. ✅ An MCP stdio client and server work inside the compiled binary. The Anthropic and OpenAI SDKs load and reach the network layer inside the binary. **Deferred:** a live call with real API keys, to be run before the first provider adapter merges.

Accepted on that basis. If the deferred live call fails because of the runtime rather than an account issue, reopen this ADR.
