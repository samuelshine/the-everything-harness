# Interactive use

Run `teh` with no `-p` to work interactively (ADR-0005, ADR-0018). The UI takes the whole terminal; `--inline` keeps it in the normal scrollback instead.
- **Model:** with no `--model`, `teh` picks one of your installed models to fit the first prompt (ADR-0014). The prompt is sorted into small, medium or large by rules that use no tokens. Then teh takes the fastest model that did as well as the best on that size of task in the model-routing eval (`evals/model-routing`). Run the eval with `--save-scores` to rank your own models. The model stays the same for the session. `--model ollama:<name>`, `TEH_MODEL` or `"model"` in settings pins one.
- **Trust:** the first time you start `teh` in a folder it asks whether you trust it. *No* still opens the folder, with the folder's own allow rules, hooks and MCP servers ignored.
- **Projects:** each directory is its own project. `teh` starts a new session; `teh -c` continues the latest one started in this directory.
- **Sending:** type a prompt and press Enter. Shift+Enter, Alt+Enter, or `\` then Enter adds a new line. Pasting a block keeps it as one prompt.
- **While it works:** Esc interrupts. Anything you type is queued and sent when it finishes.
- **Approvals:** when `teh` needs approval it asks inline. `y` allows once, `a` allows that kind of action for the rest of the session, and `n` refuses.
- **Modes:** Shift+Tab cycles the permission mode: ask, accept edits, plan.
- **Commands:** `/clear`, `/compact` and `/exit`, plus your skills and commands. `/` shows completions.
- **Settings panel:** `/status`, `/config`, `/usage` and `/help` open a panel over the prompt box. ←/→ or Tab switches tabs, Enter changes a setting, Esc closes it.
  - **This session:** permission mode, the model (switch to any installed one), full screen or inline (switched in place), and auto-compact.
  - **This project:** its model and the mode to start in, saved to `.teh/settings.local.json`, which is kept out of git.
  - **You:** your default model and start mode, and how long screen caches, sessions and undo checkpoints are kept, saved to `~/.teh/settings.json`.
- **Explore subagents:** for a broad search, the model can hand the job to a read-only subagent with its own context, usually on a smaller model. Only its report comes back, so the search does not fill your conversation (ADR-0019). It shows as `◆ Explore(...)` with a `Done` line. Set `"roles": {"explore": "ollama:<name>"}` to choose its model, or `"off"`.
- **Long conversations:** when a request would fill 75% of the model's context window, `teh` has the model summarise the older part and keeps the recent turns word for word, so long tasks keep going on small local models (ADR-0020). Your requests and the files changed are kept as written, not left to the summary. `/compact [what to focus on]` does it on demand. The full conversation stays in the session log, so `teh rewind` to a point before a compaction brings it back. Set `"autoCompact": false` to turn it off.
- **Tools:** besides Read, Write, Edit, Glob, Grep and Bash, the model has:
  - `TodoWrite`, a to-do list for multi-step work. It shows as a checklist, the item in progress names the spinner, and `/todos` shows it again. If the model stops with items unfinished, `teh` reminds it (twice at most), and compaction keeps the list.
  - `WebSearch` (DuckDuckGo by default, no key needed; set `"webSearch": {"engine": "searxng", "url": "…"}` or `{"engine": "brave"}` with `BRAVE_SEARCH_API_KEY` in `~/.teh/settings.json`) and `WebFetch`, which turns a page into Markdown and has a helper model (the explore model) read it for the question asked, so a long page doesn't fill your conversation. Both ask before reaching the network unless a rule allows them (see below), and everything fetched is marked as untrusted.
  - `NotebookEdit` for Jupyter notebooks; `Read` shows a notebook as cells with their outputs.
  - `Read` also shows images to models with vision (gemma4 has it), and reads PDFs as text, 20 pages at a time, when `pdftotext` is installed (`brew install poppler`).
  - Background shells: `Bash` with `run_in_background` starts a dev server, watcher or long build and returns at once; `BashOutput` reads what it printed since last time and `KillShell` stops it. The status line counts running shells, `/shells` lists them and `/shells kill <id|all>` stops them. They are stopped when you quit.
  - `ExitPlanMode`: in plan mode, the model presents its plan; `a` approves and accepts edits, `y` approves and keeps asking before each change, `n` keeps it planning.
- **Side questions:** `/btw <question>` answers from the conversation so far without adding to it, even while `teh` is working.
- **What you see:** replies start with `●`. Tool calls start with `◆`, and edits show a numbered diff with removed lines in red and added lines in green.
- **Scrolling:** mouse wheel, PgUp/PgDn or Shift+Up/Down. Ctrl+Home and Ctrl+End jump to the start and the end. Hold Shift (Option in some macOS terminals) to select text with the mouse.
- **Leaving:** Ctrl+D quits. `teh -c` picks the conversation up again.
- **Session cache:** what the screen showed is saved per session and drawn again when you resume. A cache untouched for 3 days is deleted; set `cacheRetentionDays` in `~/.teh/settings.json` to change that. The conversation itself is kept, so `teh -c` still continues an older session, with a shorter rebuilt view.
- **Cleanup:** sessions untouched for 30 days are deleted at startup (`cleanupPeriodDays`), and `teh sessions rm <id>` deletes one. Undo checkpoints are kept unless you set `checkpointRetentionDays`.
