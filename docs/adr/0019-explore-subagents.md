# 0019 — Explore subagents

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/08-agents-delegation.md`, `docs/research/01-context-storage-persistence.md` (subagent context modes), ADR-0003, ADR-0014; sources [AGT-02], [AGT-03], [AGT-08], [CTX-19]

## Context
Finding things in a codebase takes many Glob, Grep and Read calls, and every result stays in the conversation. On a local model with a small context window, a long search can fill most of the window before the real work starts. Every later turn then re-sends it.

The research separates two cases [AGT-02, AGT-03]:
- **Reading, searching and verifying** can be handed to subagents safely, because they don't write.
- **Writing** should stay with one agent, or parallel writers will conflict.

ADR-0014 already names an `explore` role for read-only subagents, defaulting to a cheaper model.

## Options considered
1. **No subagents.** Simple, but every search costs main-context tokens for the rest of the session.
2. **Forked subagents** that inherit the conversation [CTX-19]. They reuse the prompt cache, but the child starts with the parent's whole context, which defeats the purpose here.
3. **Isolated, read-only explore subagents** (chosen). The child gets only a written brief, works in a fresh context and returns a report.
4. **General subagents that can write.** Deferred: they bring back the multi-writer problem, and need worktrees or locks [AGT-09].

## Decision
- **The tool.** `Task` (Claude Code's name, ADR-0010) takes `description` and `prompt`. The main model calls it for open-ended searches. Its description tells the model that the subagent does not see the conversation, so the brief must be self-contained.
- **What the subagent gets:**
  - a fresh conversation holding a short brief and the task, with the normal system prompt and project instructions;
  - the read-only tools Read, Glob and Grep, plus Bash in plan mode, so only read-only commands run;
  - nobody to ask, so anything needing approval is denied;
  - a limit of 25 turns.
- **What comes back.** Only the subagent's final report, cut to 12,000 characters, plus a footer line: tool uses, tokens, seconds and model. Its steps go neither into the main conversation nor into the session log; the Task call and its result do.
- **Model.** In order:
  1. `roles.explore` in settings (project over user);
  2. the installed model teh would choose for a small task (ADR-0014);
  3. the main model.

  `"roles": {"explore": "off"}` turns subagents off.
- **Tokens.** The subagent's tokens count towards the run's usage and the `/usage` totals, but not towards the main context.
- **On screen.** The call is one line, `◆ Explore(description)`. While it runs, a line in the live area shows the latest step. When it finishes, the call gets `⎿ Done (N tool uses · T tokens · Ss · model)`. None of its steps go into the transcript.

## Consequences
- **Good:** searches no longer grow the main context, and the main model reads a summary instead of raw tool output.
- **Good:** a subagent cannot change files, so it needs no approvals and no checkpoints.
- **Cost:** the subagent re-sends the system prompt, and its findings pass through a summary that can lose detail. The main model can still Read a file itself to check.
- **Risk:** a weak explore model writes poor reports. The model-routing eval (`evals/model-routing/`) is the check on which models are good enough; `roles.explore` overrides the default.
- **Not decided here:** writing subagents, parallel subagents, forked context, and agent definition files (`.claude/agents/*.md`, [AGT-08]).
