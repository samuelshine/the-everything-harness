# Tasks

The single list of what is in flight and what is left. It lives in the repo, not in any chat session: whoever picks up the work (a person, Claude Code, or `teh` itself) starts here and updates this file in the same PR as the work.

- **Milestones and order:** [docs/roadmap.md](docs/roadmap.md). This file breaks them into tasks.
- **Decisions:** [docs/adr/](docs/adr/). A task that changes a decision updates its ADR.
- **Format:** `- [ ]` open, `- [x]` done (delete done items once their PR is merged and noted in the roadmap), `- [~]` started and saved on a branch. Add the branch or PR on the line.

*Last updated: 2026-11-19.*

## Resume here

Work stopped mid-M4 on 2026-11-19. Nothing below M1 is pushed. Every branch is committed locally; there is no uncommitted work.

| Branch | Base | Head | State |
|---|---|---|---|
| `feat/providers` | `main` | pushed | **PR #32 open** (M1). Waiting for review and merge. |
| `feat/measurement` | `feat/providers` | `7b40af9` | M2 done; partial eval results committed. Not pushed. |
| `feat/interactive` | `feat/measurement` | `d8bb8b6` | M3 done. Not pushed. |
| `feat/extensions` | `feat/interactive` | `b071714` | M4 MCP part done (`23c37df`); hooks part is a **WIP commit that does not typecheck**. Not pushed. |

The branches form a stack: each one contains the one above it. Merge them in order; after a merge, merge `main` into the next branch (no rebase or force-push).

Two of these branches were checked out in temporary worktrees under the session scratchpad. If those folders are gone, run `git worktree prune` and check the branches out again; the commits are safe in `.git`.

## M2 — Measurement (`feat/measurement`)
- [~] Finish the local terminal eval. 40 of 60 trials are saved in `evals/terminal/results/local-2026-11-19.json` (all 30 for `ollama:gemma4:e4b`, 10 for `ollama:qwen2.5:14b`). Resume with the same command; it skips finished trials:
  `bun evals/terminal/run.ts --models ollama:gemma4:e4b,ollama:qwen2.5:14b --trials 3 --out local-2026-11-19 --timeout 240` (about 25 minutes, needs Ollama running).
- [ ] Write `evals/terminal/README.md`: the task list, how to run it, and the result table (pass@1, pass^3 per model).
- [ ] Add the results to ADR-0023.
- [ ] Run `bun run check` in the main checkout (not a `/private/tmp` worktree, where two Seatbelt tests fail for location reasons).
- [ ] Push and open the PR (base `feat/providers`, note the stack in the body).
- [ ] Roadmap: move M2 to Done once merged. Research log: add a row.

## M3 — Interactive parity (`feat/interactive`)
- [ ] `bun run check` in the main checkout; push; open the PR (base `feat/measurement`).
- [ ] Research log row.
- Deferred to later (recorded in ADR-0024):
  - [ ] Clipboard image as a real image block (today it attaches the saved file's path for Read).
  - [ ] Filtering by typing in the `/resume` and `/rewind` pickers.
  - [ ] The terminal test matrix from research doc 10 §7 (tmux, Windows Terminal, JetBrains).

## M4 — Extension depth (`feat/extensions`)
MCP (done, ADR-0025): tool search, `teh mcp login`, resources, prompts, roots, `list_changed`, images, fingerprints, opt-in sandbox.

Hooks (ADR-0016), started in WIP commit `b071714`:
- [~] `"type": "http"` and `"type": "prompt"` hooks and the `SubagentStop` event, in `packages/core/src/hooks.ts`.
- [ ] Fix the typecheck error: `packages/cli/src/permissions.ts:243` reads `hook.command`, which only command hooks have. Use a label helper like `hookName`.
- [ ] Give the hook runner a `judge` in the CLI (a one-shot call to the `fast` role model, ADR-0014), so prompt hooks run.
- [ ] Fire `SubagentStop` when an explore subagent finishes (`runExplore` in `packages/core/src/agent.ts`); a block sends the reason back to the subagent for one more turn.
- [ ] Tests: HTTP hook against `Bun.serve` (2xx JSON, non-2xx, timeout, `allowedEnvVars` header substitution); prompt hook with a fake judge (ok, not ok, bad JSON); `SubagentStop`; settings parsing problems.
- [ ] Update ADR-0016 (remove the "not yet supported" line) and `docs/usage/extensions.md`.
- [ ] Squash or follow the WIP commit with a proper `feat(hooks): …` commit.

Plugins:
- [ ] ADR-0026 for plugins: Claude Code's plugin layout (`.claude-plugin/plugin.json`; `commands/`, `agents/`, `skills/`, `hooks/hooks.json`, `.mcp.json`), marketplaces, trust (plugins are code, so installing is an explicit act).
- [ ] `teh plugin install|list|enable|disable|remove`; load plugin skills, commands, hooks and MCP servers through the existing loaders.
- [ ] Tests and `docs/usage/extensions.md`.

Then:
- [ ] `bun run check` in the main checkout; push; open the PR (base `feat/interactive`).
- [ ] Research log row; roadmap.

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
