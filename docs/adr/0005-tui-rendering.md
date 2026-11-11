# 0005 — TUI rendering

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` §2 (B, D) and §7, ADR-0001, ADR-0008; sources [TRM-08], [TRM-16], [TRM-27], [TRM-31], [TRM-32]

## Context
"Usable like Claude Code" means an interactive terminal UI:
- type a prompt and watch the answer stream;
- approve actions as they come up;
- interrupt with Esc, and keep typing while the agent works.

How the UI draws is the decision that is hardest to change later. Gemini CLI moved to a full-screen (alternate screen) UI and rolled it back within about a week, because people lost native scrollback, search and copy. Claude Code kept an inline UI and rewrote its renderer to stop flicker [TRM-31].

ADR-0001 keeps the engine free of terminal code, so the UI is a separate package that drives `runAgent` exactly as `teh -p` does.

## Options considered
1. **Ink (React for the terminal)** [TRM-27]. Familiar components, but the renderer redraws the whole dynamic area, and it pulls in React, Yoga and a dozen packages. Anthropic kept the React model but replaced Ink's renderer [TRM-31].
2. **Alternate screen** (full-screen app). Full layout control, but it breaks native scrollback, find and selection, and has a record of terminal-compatibility trouble [TRM-31].
3. **Own inline differential renderer, no dependencies** (chosen).

## Decision
**Rendering** (`packages/tui/src/renderer.ts`):
- **Two parts.** Finished output (prompts, replies, tool calls, diffs) is printed **once** into the terminal's normal scrollback. Only a small **live area** at the bottom is redrawn: the reply line being streamed, the spinner, queued messages, the prompt box and the status line.
- **Differential redraws.** Only lines that changed are rewritten, inside synchronized-update escapes (DEC mode 2026), and updates within one tick are coalesced into one frame.
- **Fits the screen.** Live lines are clipped to the width, and the live area is capped at the screen height, so the cursor can always get back to its top.
- **Streaming.** As a reply streams, each finished line moves to scrollback at once, which keeps the live area small. Committed lines aren't pre-wrapped: the terminal wraps them, and copying gives back the whole line.
- **Cursor.** The editor draws its cursor as an inverse cell and the terminal's cursor stays hidden, so no cursor positioning is needed.
- **No dependencies.** Width handling covers ANSI escapes, wide characters and combining marks.

**Input** (`keys.ts`, `editor.ts`):
- **Modes and parsing:** raw mode, bracketed paste (a paste is one input, newlines included), CSI/SS3 keys.
- **New lines:** Shift+Enter in its xterm `modifyOtherKeys` and kitty forms, Alt+Enter, Ctrl+J, or `\` then Enter.
- **Editing:** multi-line, with readline keys (Ctrl+A/E/K/U/W, Alt+←/→) and ↑/↓ history.

**Behaviour** (`app.ts`):
- **Runs:** one `runAgent` per prompt, with the conversation carried over and one session log for the whole UI session.
- **Interrupt:** Esc interrupts. The conversation is then reloaded from the session log, which keeps everything up to the interrupt and closes dangling tool calls.
- **Typing while it works:** a message sent mid-run is queued and sent when the run ends. Several queued messages are joined into one.
- **Approvals** appear inline:
  - `y` allows once;
  - `a` allows for the rest of the session, using the rule the permission engine suggests (e.g. `Edit` or `Bash(npm test:*)`);
  - `n` or Esc refuses.

  Asking rings the bell and fires the `Notification` hook (ADR-0016).
- **Modes:** Shift+Tab cycles the permission mode: default → acceptEdits → plan.
- **Commands:** `/help`, `/clear` (new session; SessionStart fires with `clear`), `/cost`, `/mode`, `/exit`, plus every user-invocable skill and command. Typing `/` shows completions, and Tab completes.
- **Edits** show a coloured diff (+ green, − red, never colour alone). Read results show a line count; other results show their first line.
- **Status line:** permission mode, model, and the context size of the latest turn.
- **Accessibility:** `NO_COLOR` and `TERM=dumb` turn colour off. Every coloured mark also has a symbol (✓ ✗ ● ⎿ + −).

**Entry:** `teh` on a terminal opens the UI; `teh "prompt"` opens it with a first prompt; `-c`/`-r` resume into it; `-p` stays headless. Without a terminal, `teh` without `-p` explains how to run headlessly.

## Consequences
- **Testable without a terminal.** A small virtual terminal in the tests interprets the renderer's escape codes, so tests can assert on the screen and scrollback a person would see. The UI is tested end to end with the fake provider.
- **Resizing** redraws the live area. Terminals that reflow scrollback on resize can leave a stale copy of the live area above it; Ctrl+L redraws.
- **Not yet:**
  - plan-mode approval of a written plan;
  - `@file` mentions and `!` shell mode;
  - Ctrl+R history search and an external editor (Ctrl+G);
  - `/model` switching, `/resume` picker and `/rewind` in the UI (the `teh rewind` command works);
  - images, OSC 8 links, OSC 52 copy;
  - the skill router for interactive prompts;
  - the terminal test matrix in doc 10 §7 (tmux, Windows Terminal, JetBrains).
- **Revisit** if keeping our own renderer costs more than adopting a maintained one, or if users ask for a full-screen mode, which would come as an opt-in alternative.
