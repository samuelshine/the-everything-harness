# Tasks

The single list of what is in flight and what is left. It lives in the repo, not in any chat session: whoever picks up the work (a person, Claude Code, or `teh` itself) starts here and updates this file in the same PR as the work.

- **Milestones and order:** [docs/roadmap.md](docs/roadmap.md). This file breaks them into tasks.
- **Decisions:** [docs/adr/](docs/adr/). A task that changes a decision updates its ADR.
- **Format:** `- [ ]` open, `- [x]` done (delete done items once their PR is merged and noted in the roadmap), `- [~]` started and saved on a branch. Add the branch or PR on the line.

*Last updated: 2026-11-25.*

## Resume here

M2–M4 are finished and up for review as a stack of PRs; M5 is in progress. Merge the PRs in order; after each merge, merge `main` into the next branch (no rebase or force-push).

| Branch | Base | State |
|---|---|---|
| `feat/measurement` | `main` | M2 done, PR open. |
| `feat/interactive` | `feat/measurement` | M3 done, PR open. |
| `feat/extensions` | `feat/interactive` | M4 done (MCP, hooks, plugins), PR open. |
| `feat/delegation` | `feat/extensions` | M5 in progress, not pushed. |

When a PR merges: tick its milestone in [docs/roadmap.md](docs/roadmap.md), add a row to the research log, and delete its section below.

## M2 — Measurement (`feat/measurement`)
- [x] Terminal eval finished (60 trials): `gemma4:e4b` pass^1 70%, pass^3 50%; `qwen2.5:14b` pass^1 47%, pass^3 30%. See `evals/terminal/README.md` and ADR-0023.
- [ ] Research log row.

## M3 — Interactive parity (`feat/interactive`)
- [x] `bun run check` passes (434 tests).
- [ ] Research log row.
- Deferred to later (recorded in ADR-0024):
  - [ ] Clipboard image as a real image block (today it attaches the saved file's path for Read).
  - [ ] Filtering by typing in the `/resume` and `/rewind` pickers.
  - [ ] The terminal test matrix from research doc 10 §7 (tmux, Windows Terminal, JetBrains).

## M4 — Extension depth (`feat/extensions`)
- [x] MCP (ADR-0025), hooks (`http` and `prompt` hooks, `SubagentStop`; ADR-0016), plugins (`teh plugin …`; ADR-0026).
- [ ] Research log row.
- [ ] Count prompt-hook judge tokens in the session's usage and cost (today they are not counted).
- [ ] Plugins, deferred in ADR-0026: `teh plugin update`, adding a marketplace once and installing by bare name, version pinning, plugin output styles, signature checks, sandboxing plugin hooks and servers, project-level `enabledPlugins`.

Open after M4 (recorded in ADR-0025 and ADR-0017):
- [ ] Show full tool descriptions when a repo's MCP servers are first trusted.
- [ ] MCP sampling and elicitation (need their own design: they let a server drive the model or the user).
- [ ] Client ID metadata documents for MCP OAuth.
- [ ] A live OAuth check against a real public MCP server.
- [ ] The legacy SSE transport (only if someone needs it).

## M5 — Delegation (ADR-0007)
- [ ] Write ADR-0007: agent definitions, isolation, the verifier, and external backends.
- [ ] Agent definitions from `.claude/agents/*.md` and `~/.teh/agents/` (Claude Code's frontmatter: `name`, `description`, `tools`, `model`), listed by `teh agents`.
- [ ] A general `Task` subagent that can write, each in its own git worktree, with its diff brought back for review (ADR-0019 deferred this).
- [ ] A model per agent through the roles in ADR-0014.
- [ ] A verifier role that checks a subagent's or the main agent's work before it is reported as done.
- [ ] Claude Code and Codex as delegation backends: run the user's own installed `claude` or `codex` CLI as a subprocess. Per ADR-0009, never read, copy or proxy their credentials or config folders.
- [ ] Tests with fake providers and fake CLIs; usage doc; research log.

## Later milestones (see the roadmap)
- [ ] **M6 Memory** (ADR-0006): files first, behind a memory tool.
- [ ] **M7 Release:** telemetry (ADR-0011, ADR-0012); the Windows sandbox (ADR-0013, not yet researched); binaries and install; a changelog.
- [ ] **M8 Research features:** prompt optimiser over traces, learned routing, a long-term memory store.

## Smaller open items found in ADRs
- [ ] Honour a skill's `allowed-tools` as a grant, once it can be limited safely (ADR-0015).
- [ ] `/output-style` in the UI (ADR-0015).
- [ ] Anthropic on Bedrock and Vertex (ADR-0002).
- [ ] Live calls with real Anthropic, OpenAI and ChatGPT accounts (M1 was tested against local models and a clean 401 only).
- [ ] Run hooks inside the OS sandbox (ADR-0016, a candidate).
- [ ] Decide whether the skill router stays off by default, from eval results (ADR-0015).

## Every PR
- [ ] Update this file and, when a milestone moves, the roadmap.
- [ ] Add a row to the project research log and any new sources to the research sources sheet (both kept outside the repo by the maintainer).
