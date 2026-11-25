# Working on teh

Instructions for any coding agent (Claude Code, Codex, `teh` itself) and for people.

## Where things are tracked
- **[TASKS.md](TASKS.md)** — what is in flight and what is left, and where the last session stopped. Read it first. Update it in the same PR as the work: tick or remove finished items, add new ones, and keep "Resume here" true. Nothing about the plan should live only in a chat session.
- [docs/roadmap.md](docs/roadmap.md) — milestones and their order.
- [docs/adr/](docs/adr/) — decisions. A change to a decision updates its ADR.
- [CONTRIBUTING.md](CONTRIBUTING.md) — setup, checks and conventions.

## Rules
- `bun run check` (lint, typecheck, tests) passes before a PR.
- Tests use fake providers or recorded fixtures. No paid API keys in tests; live checks use local models (Ollama).
- Short-lived typed branches (`feat/…`, `fix/…`, `docs/…`), Conventional Commits, PRs to `main`. Never commit to `main`. Merge rather than rebase and force-push.
- `packages/core` has no terminal or process globals.
- Never impersonate a first-party client (ADR-0009): do not read `~/.claude/` or `~/.codex/`, or copy their client IDs, user agents or system prompts.
