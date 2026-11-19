# 0022 — Background shells, ExitPlanMode, images and PDFs

- **Status:** Accepted (2026-11-19, shipped)
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` (background tasks row, [CMP-16]), ADR-0003, ADR-0008, ADR-0010, ADR-0021

## Context
After ADR-0021, three parts of Claude Code's built-in tool set were still missing:
- **Long-running commands.** A dev server or `--watch` run blocked the turn until its timeout, then was killed.
- **Leaving plan mode.** The model could research in plan mode, but there was no way for it to hand over a plan and for the user to approve it in one step; the user had to switch modes by hand and say "go".
- **Images and PDFs.** Read refused binary files, so screenshots, diagrams and PDF specs were out of reach, though gemma4 can see images.

## Decision
- **Background shells.**
  - **Starting:** `Bash` takes `run_in_background`. The command goes through the same permission check, checkpoint and sandbox as any other, then starts and returns an id (`bash_1`) at once.
  - **Reading:** `BashOutput` returns only what the shell printed since the last read (stderr lines marked), whether it is running, and its exit code. An optional regular expression keeps matching lines. Each shell keeps at most 1 MB of unread output and says how much it dropped.
  - **Stopping:** `KillShell` stops the shell's whole process group (on Windows, the process).
  - **Lifetime:** the registry belongs to the session. The interactive UI keeps one across prompts, shows "N shells running" in the status line, offers `/shells` and `/shells kill <id|all>`, and kills them all on quit. A headless run kills its shells when it ends.
  - **Permissions:** reading output and killing a shell teh started need no approval.
- **ExitPlanMode** `{plan}`.
  - **Interactive:** the plan is printed into the transcript, and the user answers `a` (approve, accept edits), `y` (approve, ask before each change) or `n`/Esc (keep planning). Approval sets the run's permission mode, so the next tool call already runs under it; the model is told the new mode.
  - **Headless:** nobody can approve, so the tool tells the model to stop and give the plan as its answer.
  - It needs no approval itself: the user's answer is the approval.
- **Images.** Read returns PNG, JPEG, GIF and WebP files (up to 5 MB) as images when the model has vision (Ollama's `vision` capability, re-checked when the model changes). Otherwise it explains that the model cannot see them.
  - **Sending:** the Ollama adapter attaches them to a user message after the tool result, which every vision model reads.
  - **Size estimate:** an image counts as 1,500 tokens, not its base64 length, so it does not trigger compaction by itself.
- **PDFs.** Read uses `pdftotext -layout` (poppler) when it is installed, with page markers, 20 pages at a time (`pages: "1-5"`), and says how many pages remain. Without poppler it says how to install it. teh has no PDF parser of its own.

## Consequences
- **Good:** the model can run a dev server and check its log, or keep a watcher going, without blocking. Plan mode becomes a full workflow: research, propose, approve, act.
- **Cost:** three more tool definitions in every request. They are short, but small models pay for every token.
- **Risk:** a background command keeps running after its turn. It was approved like any command, its output is capped, and it dies with the session.
- **Risk:** images are stored in the session log as base64, up to 5 MB each.
- **Not decided here:** image input for future cloud adapters (the item format already carries it), OCR for scanned PDFs, and background subagents.
