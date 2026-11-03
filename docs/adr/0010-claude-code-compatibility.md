# 0010 — Claude Code compatibility

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` (open question on mirroring flags), `docs/research/05-skills.md`, `docs/research/06-plugins-mcp.md`, `docs/research/11-competitive-landscape.md` §4; sources [TRM-01], [TRM-03], [TRM-06], [LLM-11], [LLM-12]

## Context
The product goal is "usable like Claude Code". Most of our likely early users already have Claude Code habits and project files: `CLAUDE.md`, `.claude/skills`, `.claude/agents`, `.claude/commands`, `.mcp.json` and hooks. Each difference is a reason not to switch. On the other hand, Anthropic does not allow third-party products to present themselves as Claude Code or to use its name or logo as part of their branding [LLM-11, LLM-12].

## Options considered
1. **Mirror closely:** same flags, slash commands, key bindings and project file formats; read Claude Code's project files directly.
2. **Partial:** read `AGENTS.md`/`CLAUDE.md`, mirror only the common flags, and design the rest ourselves.
3. **Own design:** no compatibility layer.

## Decision
Option 1, within the branding rules.

1. **CLI surface:** mirror Claude Code's common flags and their meanings, for example:
   - `-p/--print`, `--output-format text|json|stream-json`
   - `-c/--continue`, `-r/--resume`, `--model`
   - `--permission-mode`, `--allowedTools`/`--disallowedTools`
   - `--add-dir`, `--append-system-prompt`, `--mcp-config`

   Built-in slash commands also match where the feature exists: `/help`, `/clear`, `/compact`, `/init`, `/model`, `/resume`, `/permissions`, `/mcp`, `/agents`, `/hooks`, `/cost`, `/memory`.
2. **Project files, read in place:**
   - Instructions: `CLAUDE.md` and `AGENTS.md` (both loaded, nearest directory first), plus `CLAUDE.local.md`.
   - Extensions: `.claude/skills/`, `.claude/agents/`, `.claude/commands/` and `.mcp.json`.
   - Hooks: the same event names and JSON payloads, so existing hook scripts run unchanged.
3. **Settings:** `teh` keeps its own `.teh/settings.json` and `~/.teh/settings.json`, using the **same schema and precedence** as Claude Code settings. We do not read `.claude/settings.json` automatically, because two tools sharing one permission file would surprise users. `teh import-settings` copies it on request.
4. **Our own name everywhere in the UI** ("The Everything Harness", `teh`). Docs may say in plain text that `teh` reads Claude Code project files. We never use Claude Code or Anthropic names or logos in our product name, UI chrome or marketing imagery.
5. **Never touch Claude Code's credentials** (ADR-0009).

## Consequences
- **We track a moving target.** Each Claude Code release can add or change flags, hook payloads or file formats. Mitigations:
  - a compatibility test suite of fixture projects (skills, agents, commands, hooks, MCP config) that must load identically;
  - a table in the docs listing each mirrored flag and command, with its status;
  - the competitive watch list (doc 11 §6) checks the Claude Code changelog.
- **Where we deliberately differ** (for example the default approval posture, ADR-0008, or features Claude Code lacks), the behaviour is documented and never silently changes the meaning of a mirrored flag.
- **Users who want a neutral format** can use `AGENTS.md` and `.teh/` equivalents. `.teh/skills/` and `.teh/agents/` are loaded alongside the `.claude/` directories, and ours win on a name clash.
- **Revisit when** Anthropic changes its policy on third-party compatibility, or when keeping parity costs more than it brings in users.
