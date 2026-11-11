# 0016 — Hooks

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/07-feedback-guidance.md` (hooks as guides and sensors), `docs/research/10-terminal-harness.md` §9, ADR-0003, ADR-0010; sources [FBK-10], [TRM-04]

## Context
A hook is a command the harness runs at a fixed point in the loop: before a tool call, after one, when a prompt is submitted, when the model wants to stop. Hooks turn "please always run the formatter" from a hope into a guarantee [FBK-10]. They are also the cheapest way to add the feedback "sensors" from doc 07: a linter after every edit, a test run before the agent may stop.

ADR-0010 commits `teh` to Claude Code's hook format: the same event names, the same JSON on stdin, the same exit codes and JSON answers, so existing hook scripts run unchanged.

Two things need deciding beyond copying the format:
- **How a hook's permission answer combines with the permission engine** (ADR-0003). Claude Code lets a PreToolUse hook's `"allow"` skip the permission prompt.
- **Trust.** A cloned repo can ship hooks in `.claude/settings.json`. Those are arbitrary shell commands that run on the user's machine with no sandbox.

## Options considered
1. **Own format** (e.g. TypeScript plugins). It's more powerful, but it breaks existing scripts and ADR-0010.
2. **Claude Code's command hooks, with teh's trust and permission rules on top** (chosen).
3. **Claude Code's format, with hooks able to override everything.** This copies Claude Code exactly, but a hook could then open up an action that a deny rule blocks.

## Decision
**Format.** The `"hooks"` section of any settings file teh reads (`~/.teh/settings.json`, `~/.claude/settings.json`, and the project's `.teh/` and `.claude/` `settings.json` and `settings.local.json`):

```json
{"hooks": {"PreToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "./lint.sh", "timeout": 30}]}]}}
```

- **Events fired:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`. `Notification` is accepted, and the interactive UI fires it when it asks for approval. `PreCompact` fires before a compaction, matched on `manual` or `auto` (ADR-0020). `SubagentStop` loads without error and does not fire yet.
- **Matcher:** a regex over the whole tool name (`Edit|Write`, `mcp__github__.*`). Empty or `*` matches everything. For SessionStart it matches the source (`startup`, `resume`).
- **Input:** one JSON object on stdin: `session_id`, `transcript_path`, `cwd`, `hook_event_name`, plus the event's own fields (`tool_name`, `tool_input`, `tool_response`, `prompt`, `stop_hook_active`, `source`, `reason`, `message`). `CLAUDE_PROJECT_DIR` and `TEH_PROJECT_DIR` are set to the project root.
- **Answer:**
  - Exit 0 succeeds. For UserPromptSubmit and SessionStart, plain stdout is added to the conversation.
  - Exit 2 blocks. Stderr goes to the model for PreToolUse, PostToolUse and Stop, and to the person for UserPromptSubmit.
  - Any other exit code is a non-blocking failure, shown to the person.
  - JSON on stdout is also understood:
    - `continue: false` + `stopReason` stops the run;
    - `systemMessage` is shown to the person;
    - `decision: "block"` + `reason` blocks;
    - `hookSpecificOutput.additionalContext` is added for the model;
    - for PreToolUse, `permissionDecision` (`allow`/`deny`/`ask`), `permissionDecisionReason` and `updatedInput`.
- **Execution:** every matching hook runs in parallel. An identical command runs once. The default timeout is 60 s.

**Permissions.** A hook can make teh stricter freely, and more permissive only within the rules:
- `deny` (or exit 2) blocks the call, even in `bypassPermissions` mode.
- `ask` turns an automatic allow into a question.
- `allow` turns a question into an allow, but **never overrides a deny rule or plan mode**. This is where teh differs from Claude Code, deliberately: deny rules are the one thing the user can always count on (ADR-0003).
- `updatedInput` is applied before the permission check, so the rewritten call is the one that gets checked and run.

**Trust.** Project hooks (from `.teh/` and `.claude/` settings in the repo) run only after `teh trust`, like project allow rules. User hooks always run. `teh hooks` lists every hook and whether it runs here.

**Records.** Each run of a hook is logged in the session. Text a hook adds to the conversation is logged as its own event, so a resumed session sends the model the same conversation.

## Consequences
- Existing Claude Code hook scripts work in teh, including ones that read `CLAUDE_PROJECT_DIR`.
- A hook can't widen what a deny rule blocks, so a script copied from Claude Code that relies on `allow` to bypass a deny rule behaves differently here. This is documented in the README.
- **Hooks are not sandboxed.** They run with the user's full rights, like Claude Code's. Trust is the only gate for project hooks. Running hooks in the OS sandbox is a candidate follow-up.
- `tool_response` is `{content, is_error}`, not Claude Code's per-tool shape. Scripts that read `tool_input` (the common case) work. Scripts that parse `tool_response` fields may need changes. Revisit if users hit this.
- Not yet supported: `"type": "prompt"` hooks (asking a model to decide), HTTP hooks, and the `SubagentStop` event.
