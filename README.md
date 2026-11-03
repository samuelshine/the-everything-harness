# The Everything Harness (`teh`)

A model-agnostic, **terminal-first** agent harness. You should be able to use it the way you use Claude Code: start it in a repo, talk to it, and let it read, edit and run things under rules you control. It handles context, tools, memory, skills, plugins/MCP, delegation, verification and safety, and works across LLM providers.

## Status
**Early development.** Headless mode (`teh -p`) works with local models through [Ollama](https://ollama.com): it reads, searches, edits and runs commands under permission rules, and logs each session. `teh undo` reverts a run's file changes. There is no interactive UI and no cloud providers yet. Background reading:
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
  cli/             `teh` entrypoint, headless mode, flags
spikes/            throwaway experiments that validate an ADR
CONTRIBUTING.md    branching, commits, PRs, development setup
```
Planned:
```
packages/
  tui/             terminal client
  sandbox/         OS sandbox adapters
evals/             task suites and harness benchmarks
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
`teh` asks before every change by default (ADR-0008). Headless mode cannot ask, so it denies those actions and tells you which flags would allow them:
- `--permission-mode acceptEdits` allows file edits inside the workspace.
- `--allowedTools "Bash(npm test)"` allows that exact command. Rules match whole commands only for now.
- `--disallowedTools Bash` blocks a tool entirely. Deny rules win over everything.

Each run is saved as a session. `teh -p -c "..."` continues the most recent one with its full conversation and model. `teh sessions` lists them, and `teh -p -r <id> "..."` continues a specific one.

Before a run changes anything, `teh` snapshots the project into a separate shadow git repository under `~/.teh` (ADR-0004). It never touches your own `.git`. This covers changes made by shell commands too.
- `teh undo` puts files back as they were before the last run that changed them, after showing what will change. Run it again to step further back.
- `teh checkpoints` lists snapshots, and `teh restore <id>` returns to any of them. Every restore prints an id that undoes it.
- Ignored files (`.gitignore`, `.teh/checkpoint-ignore`) and files over 10 MB are not snapshotted and are never overwritten by a restore.

Other flags: `--output-format text|json|stream-json`, `--max-turns`, `--add-dir`. The model can also come from `TEH_MODEL`. Ollama is found through `OLLAMA_HOST`, and `TEH_OLLAMA_NUM_CTX` sets the context window (default 65536, capped at the model's maximum). Sessions are saved as JSONL under `~/.teh/projects/` (ADR-0004). `teh` reads `AGENTS.md` and `CLAUDE.md` like Claude Code does.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[Apache License 2.0](LICENSE). Contributions are accepted under the same license (section 5 of the license).
