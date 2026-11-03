# 0004 — Session storage and checkpoints

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` §2A and §5, `docs/research/01-context-storage-persistence.md`, `docs/product.md`; sources [TRM-05], [TRM-07], [TRM-32], [CTX-03]

## Context
`teh` needs to:
- **continue and resume** a conversation, **fork** it, and **rewind** to an earlier turn;
- **undo file changes**, including changes made through bash, which Claude Code's checkpoints miss [TRM-05];
- keep an **audit trail** of what the agent did and why;
- feed **evals** and replays.

The product brief adds that sessions carry an owner, so later collaboration features are additive. ADR-0011 adds that telemetry never reads session content.

## Options considered
1. **SQLite database** for sessions. Good for queries, but harder to inspect, diff, stream or hand to another tool, and it adds schema migrations from day one.
2. **Append-only JSONL event log per session** (chosen for sessions). Easy to read, safe to append, and it streams naturally to the headless `stream-json` output. Claude Code and pi use the same shape [TRM-07, TRM-32].
3. For **file undo**:
   - **(a) snapshot only files our edit tools touch.** This misses bash changes.
   - **(b) a shadow git repository that snapshots the whole worktree each turn** (chosen).
   - **(c) commits in the user's own repo.** This pollutes their history.

## Decision

**Location.** Sessions live outside the project, so they are never committed by accident:

```
~/.teh/projects/<project-key>/
  sessions/<session-id>.jsonl
  shadow.git/                  # checkpoint store for this project
```

The project key is the git root's absolute path (or the cwd's, outside git), sanitised and suffixed with a short hash. Files are created with mode `0600` and directories with `0700`.

**Event log.**
- One JSON object per line, with these fields:
  - `v` (schema version);
  - `id` (sortable unique id);
  - `parent` (the previous event's id; this makes the log a tree);
  - `ts`, `session`, `owner`, `type`, and a type-specific `data` payload.
- Event types:

  | Area | Event types |
  |---|---|
  | Session | `session_start` (cwd, `teh` version, settings hash), `session_end` |
  | Conversation | `user_message`, `assistant_item` (one canonical item from ADR-0002), `tool_call`, `tool_result` |
  | Approvals | `approval` (prompt shown, decision, rule written) |
  | Models | `model_change` (pin, role or routing decision, with the reason; ADR-0014), `usage` (tokens, cost, auth route) |
  | State | `checkpoint` (shadow commit sha), `compaction` (summary text and the id range it replaces), `rewind` (target event id) |
  | Failures | `error` |
- **Append-only.** Nothing is rewritten or deleted during a session.
  - **Rewind** appends a `rewind` event and continues from the target. Later events stay in the file as an abandoned branch.
  - **Fork** creates a new file whose `session_start` references the parent session and event id. The new file does not copy the parent's events.
- **Crash safety.** Each event is written with a single `write` call, and the file is flushed at the end of each turn. A torn final line is ignored on load.
- **Resume** replays events into engine state. A `compaction` event lets replay skip the events it summarises, so long sessions resume quickly.
- **Headless:** `--output-format stream-json` emits the same events, minus internal-only fields, so scripts and the future TUI consume one format.

**Checkpoints.**
- **The store.** A shadow git repository per project (`shadow.git`) uses the project directory as its work tree (`GIT_DIR` and `GIT_WORK_TREE` are set explicitly). It **never touches the user's `.git`**, index, branches or config.
- **When a snapshot is taken.** Before the first mutating action of each turn, `teh` snapshots the worktree (`add -A` and `write-tree`, then a commit object) and records the sha in a `checkpoint` event. This captures changes made by any tool, bash included.
- **What is skipped:** anything matched by `.gitignore` plus `.teh/checkpoint-ignore`, files over 10 MB, and the user's `.git`.
- **Restore** (`/rewind`, Esc Esc) offers three choices: code only, conversation only, or both. It shows the diff and **asks first** (ADR-0008). Restoring creates a new checkpoint first, so a restore can itself be undone.
- **Outside a git repo it still works**, because the shadow repo doesn't need one.
- **Requires a `git` binary.** If git is missing, `teh` falls back to snapshotting only the files its own tools touch, and both `/doctor` and the rewind prompt say that bash changes are not covered.

**Retention.** Sessions and shadow history are kept 30 days by default (`cleanupPeriodDays`, the same setting name as Claude Code, per ADR-0010). Shadow history is pruned with `gc` in the background. `teh sessions rm` deletes a session explicitly.

## Consequences
- **Sessions contain sensitive content** (prompts, code, command output). They stay local, are created with owner-only permissions, are never sent anywhere by `teh`, and are never read by telemetry (ADR-0011). Export and share (P1/P2) must redact known secret patterns and show what will be shared before sending.
- **Disk use grows with the repo size × turns.** Git's object deduplication keeps it modest, and `/doctor` reports usage per project.
- **The schema is versioned from day one** (`v`). Readers accept older versions, and a breaking change needs a migration plus a note in the changelog.
- **Evals reuse the format.** An eval run is a session, so graders read the same files.
- **Revisit** if search across sessions becomes a core feature. An SQLite index built *from* the JSONL files can be added without changing the source of truth.
