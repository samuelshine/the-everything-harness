# 0008 — Default approval posture

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` §4, `docs/research/00-synthesis.md` §5.6, `docs/research/11-competitive-landscape.md` §3; sources [TRM-04], [TRM-19]

## Context
On first run, a coding agent either asks before acting or acts and lets the user review afterwards. The two failure modes:
- **Asking too much** causes prompt fatigue. Users approve without reading, or switch to a "yolo" flag that removes every safeguard (doc 11 §3).
- **Asking too little** causes damage the user never saw coming: deleted files, pushed commits, leaked secrets (doc 11 §2 incidents).

The research leaned towards Codex's approach: a sandboxed `workspace-write` mode that edits freely inside the project and asks only to escape the sandbox.

## Options considered
1. **Ask before every action that changes something** (Claude Code's `default` mode). The most transparent and the easiest to trust on day one. Risks prompt fatigue.
2. **Sandboxed workspace-write, ask only for escapes** (Codex). Fewer prompts, but the user sees changes only after they happen, and safety rests on the sandbox, which does not exist on Windows yet.
3. **Fully automatic with a reviewer model** (auto mode). Fastest, but the least predictable for a new tool nobody trusts yet.

## Decision
Option 1. By default `teh`:
- **Runs read-only actions without asking:** reading files, search, listing, and shell commands that the permission engine parses as read-only.
- **Asks before:** every file edit or write, every shell command that is not provably read-only, every network-reaching tool, and every MCP tool call.
- **Offers in each prompt:** *yes*, *yes and don't ask again for this exact command/path this session*, *yes and always allow* (written to project settings as an allow rule), and *no, and tell the agent what to do instead*.
- **Keeps the OS sandbox on underneath** where available (macOS, Linux), so an approved command still cannot write outside the workspace or reach the network unless the user has allowed it. Approval and sandbox are separate layers (ADR-0003).

Other modes stay available behind an explicit flag or setting: `plan` (read-only), `accept-edits` (file edits auto-approved, commands still ask), `workspace-write` (Codex-style) and, later, `auto`. The names follow ADR-0010.

## Consequences
- **Prompt fatigue is the main risk**, and these are the countermeasures:
  - rule-based allow lists, matched against the parsed shell command, never by prefix;
  - session-scoped "don't ask again";
  - batching several edits from one turn into a single reviewable diff prompt;
  - a visible mode indicator, so switching to `accept-edits` is one keystroke.
- **Every prompt must be easy to read:** the exact command or a diff, why the agent wants it, and what it touches. A prompt that cannot be understood at a glance gets rubber-stamped.
- **Headless `-p` cannot prompt.** With no allow rules, it fails closed on any action that needs approval and says which rule would allow it, as Claude Code does.
- **Revisit when** telemetry (ADR-0011) shows users approving almost every prompt, or switching modes in most sessions. Either signal means the default is costing more than it protects.
