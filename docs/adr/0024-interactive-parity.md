# 0024 — Interactive parity: mentions, shell mode, history, pickers, links and copy

- **Status:** Accepted (2026-11-19, shipped)
- **Date:** 2026-11-19
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` (input and UX rows), ADR-0004, ADR-0005, ADR-0008, ADR-0010, ADR-0015

## Context
ADR-0005 listed what the UI still lacked next to Claude Code: `@file` mentions, `!` shell mode, Ctrl+R and Ctrl+G, the `/resume` and `/rewind` pickers, images, OSC 8 links, OSC 52 copy, and the skill router for interactive prompts. People moving from Claude Code reach for these by habit (ADR-0010), so their absence reads as breakage. Each one also raises a question about permissions or where state lives.

## Decision
- **`@path` attaches the file's text to the prompt.** The file is not left for the model to read with a tool call. Folders attach a listing of up to 200 entries; files attach up to 2,000 lines or 100 KB, with a note on how to read the rest.
  - **No approval:** the person named the file, which is the approval, as in Claude Code.
  - **Deny rules still apply:** a `Read` deny rule (e.g. `Read(./.env)`) blocks the attachment and the UI says so. Missing and binary files are reported, not sent.
  - **Images** are attached as a pointer for the Read tool, which already sends images to models with vision (ADR-0022). This keeps one image path through the providers.
  - **Completion** offers paths from `git ls-files` (tracked and untracked, ignoring what git ignores), or a bounded walk that skips dependency folders. They are ranked by prefix, then file name, then substring, then in-order letters.
- **`!command` runs in the person's shell** (`$SHELL -c`) in the project folder, with no sandbox and no approval: the person typed it. The output is shown (30 lines) and goes in front of the next prompt as `<bash-input>`/`<bash-output>` (up to 30,000 characters). It is not sent as a message of its own, because some providers reject two user messages in a row. Esc or Ctrl+C stops it.
- **Prompt history** lives in `~/.teh/history.jsonl` (mode 0600), one line per prompt with the project folder, so ↑ and Ctrl+R reach earlier sessions in the same project. Ctrl+R is incremental: Ctrl+R again steps to older matches, Enter takes the match for editing, and Esc restores the draft.
- **Ctrl+G** hands the terminal to `$VISUAL` or `$EDITOR` on a temporary file. The UI leaves raw mode and the alternate screen first, then restores both. `EDITOR="code --wait"` works because the command goes through `sh`; the file path is passed as `$1`, never spliced into the command.
- **Ctrl+V** saves an image on the clipboard to `~/.teh/cache/pasted/` and inserts it as an `@` path. On macOS it uses `osascript`; on Linux, `wl-paste` or `xclip`. Text paste is unchanged (bracketed paste).
- **`/resume` and `/rewind` are pickers** over the same data as `teh sessions` and `teh rewind` (ADR-0004). The plan and apply steps of `teh rewind` were split out so both use one code path.
  - Picking a point and then choosing what goes back (code and conversation, conversation only, code only) are two explicit choices; together they are the confirmation ADR-0008 asks for.
  - Going back to a prompt puts its text in the prompt box, as Claude Code does.
  - The rewind is recorded as a point, so it can be undone.
- **OSC 8 links** for Markdown links and bare `http(s)` addresses in replies, only in terminals known to support them, detected from `TERM_PROGRAM`, `VTE_VERSION`, `WT_SESSION`, `KITTY_WINDOW_ID` and `TERM`. They are off inside tmux and screen. `TEH_HYPERLINKS` overrides. Only `http(s)` addresses without control characters are ever put inside an escape sequence. Without link support, a link whose text differs from its address shows the address in brackets. Wrapping closes a link at each line break and reopens it on the next line.
- **`/copy` uses OSC 52**, so it works over SSH without a clipboard tool. It copies the last reply.
- **The skill router** runs on each interactive prompt when enabled (`--skill-router`), as it does for `teh -p`. The chosen skill is shown under the prompt.

## Consequences
- `packages/core` gained `mentions.ts` (pure, no terminal). The machine-facing parts (shell, editor, clipboard, history file, terminal detection) live in `packages/cli/src/interactive.ts` and are injected into the UI, so the UI tests need no real shell, editor or clipboard.
- `!` commands run outside the sandbox by design. A person who wants them sandboxed should ask the model to run them instead.
- Attached files sit in the prompt and so in the session log. That is the same exposure as the model reading them with Read.
- **Still open:** the terminal matrix in doc 10 §7 (tmux, Windows Terminal, JetBrains) has not been run by hand. The picker has no type-to-filter yet.
- **Revisit when** a provider-level image block for user messages exists (then `@image.png` can attach the image itself), or when people ask for `!` to be sandboxed.
