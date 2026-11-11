# 0020 — Context compaction

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/01-context-storage-persistence.md` §Compress, `docs/research/10-terminal-harness.md` (compaction row), `docs/research/12-model-routing-and-local-models.md` (model-aware budgets), ADR-0004, ADR-0010, ADR-0016; sources [CTX-01], [CTX-02], [TRM-32]

## Context
Before this, a conversation that outgrew the model's context window just failed. On Ollama, teh refuses a request estimated above 90% of the window rather than let Ollama cut the prompt silently. A local model running with a 16k–64k window reaches that after a handful of file reads. Long tasks and long sessions were therefore impossible on exactly the models teh is meant to run well on.

The research names compaction as the standard answer [CTX-01]: near the limit, summarise the history and continue from the summary plus recent turns, keeping decisions, unresolved bugs and open tasks. Claude Code does this automatically and with `/compact [focus]`, and fires `PreCompact` and `SessionStart` (source `compact`) hooks around it (ADR-0010, ADR-0016).

## Options considered
1. **Truncate the oldest turns.** Free, but the model loses the user's original request and earlier decisions without knowing it.
2. **Clear old tool results only** [CTX-02]. Cheap and keeps the conversation's shape, but a long session of prompts and replies still overflows. A good first stage, not a replacement.
3. **Summarise the older part, keep recent turns verbatim** (chosen). Costs one model call, keeps the thread.
4. **Provider-side compaction.** Not available on local models.

## Decision
- **When.** Before every model request in a run. teh estimates the request at about 4 characters per token, scaled by what the provider reported for the previous request (code and numbers take more tokens than prose; the live check below undercounted by about 1.5× without this). When the estimate passes **75%** of the window, it compacts. The scale carries over from one prompt to the next in the interactive UI. If the provider still refuses a request as too long, teh compacts everything and retries once.
- **What is kept.** The newest items, up to 25% of the window, word for word. The cut never separates a tool call from its result. `/compact` keeps nothing verbatim, as in Claude Code.
- **The summary.** The same model writes it, from a plain-text rendering of the older part with each tool result clipped to 1,500 characters. A part too long for the window is read in chunks, each folding in the summary so far. The prompt asks for: goal, requests and whether each is done, decisions, files and their state, errors, current work, next step.
- **What does not depend on the summary.** teh adds the user's own prompts (the last 15, oldest first, carried forward across compactions), the files written or edited in the compacted part, the latest request verbatim when it was compacted, and a reminder to re-read files before editing them.
- **Session log.** A `compact` event records the summary message and how many trailing items were kept. Replaying the log rebuilds the compacted conversation, so `teh -c` continues from it. Earlier states are untouched, so rewinding to a point before the compaction brings the full conversation back (ADR-0004).
- **Hooks.** `PreCompact` fires with `trigger` (`manual` or `auto`) and `custom_instructions`, matched on the trigger. After an automatic compaction `SessionStart` fires with source `compact` and its output joins the conversation; after `/compact` it fires on the next prompt.
- **Interface.** `/compact [focus]` in the interactive UI; the spinner says "Compacting the conversation…". A dimmed line marks it in the transcript, with before and after sizes; the transcript on screen is not cleared. The status line shows the context percentage once it passes 50%, and when compaction will happen. The Config tab toggles `autoCompact`, saved in user settings; a project's `autoCompact` wins. Headless runs print `› conversation compacted` to stderr.

## Consequences
- **Good:** long tasks run on small windows. Live check, gemma4:e4b with a 12k window: read seven files and write a result that needed a value from the first; three automatic compactions; correct answer. Without compaction the same run stopped at the window limit after the third file.
- **Good:** the conversation is never lost: the log keeps it, and rewind restores it.
- **Cost:** one extra model call per compaction, and the summary can drop detail. The deterministic parts (requests, changed files) are there so the most important facts do not depend on it.
- **Risk:** a weak model writes a weak summary. The compaction eval (`evals/compaction/`) is the check.
- **Not decided here:** clearing old tool results before summarising [CTX-02]; a separate `compact` model role (ADR-0014); carrying a to-do list across compaction [TRM-32], which waits for a to-do tool.
