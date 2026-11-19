# Sessions, rewind and checkpoints

Each run is saved as a session. `teh -p -c "..."` continues the most recent one with its full conversation and model. `teh sessions` lists them, and `teh -p -r <id> "..."` continues a specific one.

Before a run changes anything, `teh` snapshots the project into a separate shadow git repository under `~/.teh` (ADR-0004). It never touches your own `.git`. This covers changes made by shell commands too.
- `teh rewind` lists every point you can go back to in the latest session, titled and grouped by prompt: the start of each prompt, and before each step that changed files (for example "Before: Edit math.js"). Pick one, then choose what goes back: code and conversation, conversation only, or code only. It shows exactly what will change and asks first. Points you rewind past stay listed, and every rewind adds a point to return to, so nothing is lost. Without a terminal: `teh rewind 3 --yes` (add `--code-only` or `--conversation-only`).
- `teh undo` puts files back as they were before the last run that changed them, after showing what will change. Run it again to step further back.
- `teh checkpoints` lists snapshots, and `teh restore <id>` returns to any of them. Every restore prints an id that undoes it.
- Ignored files (`.gitignore`, `.teh/checkpoint-ignore`) and files over 10 MB are not snapshotted and are never overwritten by a restore.

## Other flags
Other flags: `--output-format text|json|stream-json`, `--max-turns`, `--add-dir`. The model can also come from `TEH_MODEL`. Ollama is found through `OLLAMA_HOST`, and `TEH_OLLAMA_NUM_CTX` sets the context window (default 65536, capped at the model's maximum). Sessions are saved as JSONL under `~/.teh/projects/` (ADR-0004). `teh` reads `AGENTS.md` and `CLAUDE.md` like Claude Code does.
