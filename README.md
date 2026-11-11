# The Everything Harness (`teh`)

A model-agnostic, **terminal-first** agent harness. You should be able to use it the way you use Claude Code: start it in a repo, talk to it, and let it read, edit and run things under rules you control. It handles context, tools, memory, skills, plugins/MCP, delegation, verification and safety, and works across LLM providers.

## Status
**Early development.** `teh` works with local models through [Ollama](https://ollama.com): it reads, searches, edits and runs commands under permission rules, and logs each session. `teh undo` reverts a run's file changes. Running `teh` on its own opens an interactive terminal UI. Hooks run in Claude Code's format, and it connects to MCP servers over stdio and HTTP. There are no cloud providers yet. Background reading:
- [Product brief](docs/product.md): name, audience, and the product decisions so far.
- [Synthesis](docs/research/00-synthesis.md): principles, reference architecture, build order, open decisions.
- [Terminal harness requirements](docs/research/10-terminal-harness.md): what "usable like Claude Code" means, feature by feature.
- [Competitive landscape](docs/research/11-competitive-landscape.md): what Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider and others get right and wrong.

Every claim is cited to [`docs/research/sources.csv`](docs/research/sources.csv), which is mirrored to the project's Google Sheet.

## Repository layout
```
docs/
  research/        literature review, one file per topic, plus sources.csv
    tools/         scripts that maintain the research docs
  adr/             architecture decision records (decisions taken from the research)
packages/
  core/            engine: loop, sessions, tools, permissions, context, providers
  tui/             interactive terminal UI: inline renderer, prompt editor, approvals
  cli/             `teh` entrypoint, headless mode, flags
evals/             measurements behind design choices (e.g. skill-routing)
spikes/            throwaway experiments that validate an ADR
CONTRIBUTING.md    branching, commits, PRs, development setup
```
Planned:
```
packages/
  sandbox/         OS sandbox adapters
```

## Development
Requires [Bun](https://bun.sh) 1.4.3 (`curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3`).
```bash
bun install          # install dependencies
bun run check        # lint + typecheck + tests (what CI runs)
bun run build        # compile packages/cli/dist/teh
bun packages/cli/src/main.ts --help   # run from source
```

## Try it (free, local)
```bash
ollama pull gemma4:e4b        # any Ollama model with tool calling works; this one behaves well
bun run build
packages/cli/dist/teh models  # list local models and whether they support tools
packages/cli/dist/teh -p --model ollama:gemma4:e4b "What does this repo do?"
```
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
- **Side questions:** `/btw <question>` answers from the conversation so far without adding to it, even while `teh` is working.
- **What you see:** replies start with `●`. Tool calls start with `◆`, and edits show a numbered diff with removed lines in red and added lines in green.
- **Scrolling:** mouse wheel, PgUp/PgDn or Shift+Up/Down. Ctrl+Home and Ctrl+End jump to the start and the end. Hold Shift (Option in some macOS terminals) to select text with the mouse.
- **Leaving:** Ctrl+D quits. `teh -c` picks the conversation up again.
- **Session cache:** what the screen showed is saved per session and drawn again when you resume. A cache untouched for 3 days is deleted; set `cacheRetentionDays` in `~/.teh/settings.json` to change that. The conversation itself is kept, so `teh -c` still continues an older session, with a shorter rebuilt view.
- **Cleanup:** sessions untouched for 30 days are deleted at startup (`cleanupPeriodDays`), and `teh sessions rm <id>` deletes one. Undo checkpoints are kept unless you set `checkpointRetentionDays`.

`teh` asks before every change by default (ADR-0008). Reading the project and read-only commands such as `ls`, `cat`, `grep`, `sed -n 1,20p` and `git status/log/diff` run without asking. Headless mode cannot ask, so it denies everything else and prints the rule that would allow it:
- `--permission-mode acceptEdits` allows file edits inside the workspace.
- `--allowedTools 'Bash(npm test:*)'` allows `npm test` with any arguments. `'Bash(npm test)'` allows only that exact command.
- `--disallowedTools 'Bash(git push:*)' 'Read(.env)'` blocks those. Deny rules win over everything, including `bypassPermissions`.

Rules apply to each part of a command: `npm test && git status` runs with only `Bash(npm test:*)` allowed, but `npm test; rm -rf ~` still asks. A command the parser can't read fully, such as one with `$(…)` or a here-doc, always asks (ADR-0003).

Rules can also live in settings files, in Claude Code's format: `{"permissions": {"allow": [...], "ask": [...], "deny": [...]}}`.
- **Where:** `~/.teh/settings.json` and `~/.claude/settings.json` for you, and `.teh/settings.json` or `.claude/settings.json` (plus `settings.local.json`) for a project.
- **Trust:** a cloned repo's allow rules, and its skills' `allowed-tools`, are ignored until you run `teh trust` in it. Its deny and ask rules apply at once.
- **Protected folders:** writes inside `.git`, `.teh`, `.claude` and `.agents` always ask.
- **Checking:** `teh permissions` shows every rule in effect and where it comes from.

Shell commands also run in an OS sandbox on macOS (Seatbelt) and Linux (bubblewrap; install the `bubblewrap` package):
- **Commands that ran without asking** can't write anything outside the temp folder, have no network, and can't see `~/.ssh`, `~/.aws` and other credential folders.
- **Commands you or a rule allowed** can write only inside the project, the temp folder and package caches. They have network access unless you set `"sandbox": {"network": false}`.
- **Always read-only:** `.teh`, `.claude`, `.agents`, `.git/hooks` and `.git/config`.
- **Settings:** add writable folders with `"sandbox": {"allowWrite": ["~/other"]}`.
- **Turning it off:** `--sandbox off`. `--sandbox on` refuses to run without one.
- **Windows:** no sandbox yet.

Output styles change how `teh` works and replies for a whole session. Pick one with `--output-style <name>`, or set `"outputStyle"` in settings:
- `explanatory` adds short "Insight" notes on why the code is shaped the way it is;
- `learning` hands you small key pieces to write, marked `TODO(human)`, and then reviews them;
- your own `~/.teh/output-styles/<name>.md` or `.claude/output-styles/<name>.md` files work too, including Claude Code's.

`teh styles` lists them.

Hooks run your own commands at fixed points in the loop, in Claude Code's format, so existing hook scripts work as they are. Put them under `"hooks"` in any settings file:
```json
{"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "npx eslint --fix \"$CLAUDE_PROJECT_DIR\""}]}]}}
```
- **Events:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`. The hook gets the event as JSON on stdin.
- **Blocking:** exit code 2 blocks the action, and stderr tells the model (or you, for a prompt) why. A `Stop` hook that exits 2 sends the model back to work.
- **Permissions:** a `PreToolUse` hook can deny anything, even in `bypassPermissions` mode. Its `"allow"` skips the question but, unlike in Claude Code, never overrides a deny rule (ADR-0016).
- **Trust:** a repo's own hooks run only after `teh trust`. `teh hooks` lists every hook and whether it runs here.
MCP servers add tools from outside `teh` (GitHub, a browser, a database). Configure them in Claude Code's format, in `.mcp.json` in the project, `~/.teh/mcp.json`, or `--mcp-config`:
```json
{"mcpServers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"}}}}
```
- **Transports:** stdio servers (`"command"`, `"args"`, `"env"`) and streamable HTTP servers (`"type": "http"`). OAuth sign-in isn't supported yet; use a header.
- **Tool names:** each tool is named `mcp__<server>__<tool>`, so Claude Code permission rules carry over.
- **Permissions:** every MCP call asks first. `--allowedTools mcp__github` allows a whole server; `mcp__github__get_issue` allows one tool. `acceptEdits` doesn't cover MCP tools, and plan mode runs only the allowed ones.
- **Trust:** a repo's `.mcp.json` servers start only after `teh trust`.
- **Checking:** `teh mcp` starts each server and lists its tools.

Each run is saved as a session. `teh -p -c "..."` continues the most recent one with its full conversation and model. `teh sessions` lists them, and `teh -p -r <id> "..."` continues a specific one.

Before a run changes anything, `teh` snapshots the project into a separate shadow git repository under `~/.teh` (ADR-0004). It never touches your own `.git`. This covers changes made by shell commands too.
- `teh rewind` lists every point you can go back to in the latest session, titled and grouped by prompt: the start of each prompt, and before each step that changed files (for example "Before: Edit math.js"). Pick one, then choose what goes back: code and conversation, conversation only, or code only. It shows exactly what will change and asks first. Points you rewind past stay listed, and every rewind adds a point to return to, so nothing is lost. Without a terminal: `teh rewind 3 --yes` (add `--code-only` or `--conversation-only`).
- `teh undo` puts files back as they were before the last run that changed them, after showing what will change. Run it again to step further back.
- `teh checkpoints` lists snapshots, and `teh restore <id>` returns to any of them. Every restore prints an id that undoes it.
- Ignored files (`.gitignore`, `.teh/checkpoint-ignore`) and files over 10 MB are not snapshotted and are never overwritten by a restore.

**Skills and commands** (ADR-0015). `teh` reads skills in the Agent Skills format and Claude Code's commands, so the ones you already have work as they are. It looks in `~/.teh/`, `~/.claude/`, and the project's `.teh/`, `.agents/` and `.claude/` folders; your own copy wins over a project's.
- `teh skills` lists them.
- `teh -p "/human tidy README.md"` runs one by name.
- The model also sees each skill's name and description, and loads a skill with the `Skill` tool when a request fits, for example "make this sound less like AI wrote it".
- `--skill-router embed` (or `TEH_SKILL_ROUTER=embed`) has a local embedding model (`nomic-embed-text`) suggest a skill before the model starts. `embed+confirm` also asks a small model, set with `TEH_SKILL_ROUTER_MODEL=ollama:qwen2.5:0.5b`, to check the suggestion. Both are off by default; see [evals/skill-routing](evals/skill-routing/README.md) for when they help.

Other flags: `--output-format text|json|stream-json`, `--max-turns`, `--add-dir`. The model can also come from `TEH_MODEL`. Ollama is found through `OLLAMA_HOST`, and `TEH_OLLAMA_NUM_CTX` sets the context window (default 65536, capped at the model's maximum). Sessions are saved as JSONL under `~/.teh/projects/` (ADR-0004). `teh` reads `AGENTS.md` and `CLAUDE.md` like Claude Code does.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[Apache License 2.0](LICENSE). Contributions are accepted under the same license (section 5 of the license).
