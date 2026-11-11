# 0018 — Full-screen UI by default, and a session cache kept for 3 days

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` §2 and §7, ADR-0004, ADR-0005; sources [TRM-08], [TRM-16], [TRM-27]

## Context
ADR-0005 chose an inline renderer: finished output goes to the terminal's own scrollback and only a small live area redraws. It works, but it does not feel like an application:
- the prompt box moves down the screen as output arrives, and nothing stays in a fixed place;
- a resumed session starts with an empty screen, because what was shown before lives only in the old terminal's scrollback.

The maintainer asked for a full-screen experience in which each session's view is saved, kept for 3 days, and then deleted, while `teh --continue` goes on working after that.

## Options considered
1. **Stay inline only.** Keeps native scrollback and selection, but gives neither a fixed layout nor a redrawn transcript.
2. **Full screen only.** Simplest to maintain, but breaks in terminals without an alternate screen and removes the one mode in which output survives in scrollback after exit.
3. **Full screen by default, inline as a fallback** (chosen). Both renderers sit behind one `Screen` interface, so the app code is shared.

For what to keep, and for how long:
1. **Expire the whole session after 3 days.** `--continue` would then fail, which the request rules out.
2. **Keep everything forever.** Rendered transcripts hold tool output and diffs and grow much faster than the conversation.
3. **Split the two** (chosen). The conversation stays in the session log (ADR-0004). What the UI showed is a cache with a short life.

## Decision
**Full screen.**
- The interactive UI runs on the alternate screen: one header line (`teh · model`, working directory), the conversation in a scrollable viewport, and the live area (streaming text, approvals, prompt box, status) pinned to the bottom.
- Frames are diffed by row and only changed rows are rewritten, inside synchronized updates.
- **Scrolling:** mouse wheel, PgUp/PgDn, Shift+Up/Down, Ctrl+Home/End. Scrolling up holds the view while new output arrives and shows how many lines are below. Scroll keys work during an approval.
- **Mouse:** only wheel reporting is enabled. Selecting text then needs Shift (Option in some macOS terminals), as in other full-screen programs.
- **Leaving** restores the previous screen and prints the `teh -c` hint.
- **Fallback:** `--inline` selects the ADR-0005 renderer. `TERM=dumb` selects it automatically. Headless mode (`-p`) is unchanged.

**Session cache.**
- **What:** the lines the UI committed to the transcript, as shown, at `~/.teh/projects/<project>/cache/<session>.transcript.jsonl` (mode 0600, one JSON array per write).
- **Use:** when a session is resumed, its cached transcript is drawn again above a "resumed" rule, tool output and diffs included.
- **Retention:** a cache file not written for `cacheRetentionDays` days (default 3) is deleted. Pruning runs at every start, across all projects. The setting is read from user settings only; `0` keeps no cache between runs.
- **After expiry:** the session log is untouched, so `teh -c` and `teh -r <id>` send the full conversation as before. The transcript is rebuilt from the conversation in a shorter form (prompts, replies, one line per tool call and result), with a note saying so, and cached again.

## Consequences
- **Good:** a fixed layout, scrollback that the app controls, and a resumed session that looks the way it was left.
- **Good:** disk use for rendered output is bounded by a few days of activity.
- **Cost:** output no longer stays in the terminal's scrollback after exit, and plain drag-select needs a modifier. `--inline` remains for people who want either.
- **Cost:** a second renderer to maintain. The shared `Screen` interface and the virtual-terminal tests keep that small.
- **Sensitive data:** the cache holds the same tool output the session log does, with the same file permissions, for a shorter time.
- **Not decided here:** checkpoints (`shadow.git`) and session logs are not pruned by this setting. ADR-0004's 30-day session cleanup is still to be built.
- **ADR-0005:** its renderer and interaction model stand. Its choice of inline as the default is superseded by this record.
