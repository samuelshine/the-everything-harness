# The Everything Harness (`teh`)

A model-agnostic, **terminal-first** agent harness. You should be able to use it the way you use Claude Code: start it in a repo, talk to it, and let it read, edit and run things under rules you control. It handles context, tools, memory, skills, plugins/MCP, delegation, verification and safety, and works across LLM providers.

## Status
**Early development.** `teh` works with local models (Ollama, LM Studio, llama.cpp, vLLM), with Anthropic and OpenAI API keys, and with your ChatGPT plan ([providers](docs/usage/providers.md)): it reads, searches, edits and runs commands under permission rules, and logs each session. `teh undo` reverts a run's file changes. Running `teh` on its own opens an interactive terminal UI. Hooks run in Claude Code's format, and it connects to MCP servers over stdio and HTTP. Background reading:
- [Product brief](docs/product.md): name, audience, and the product decisions so far.
- [Synthesis](docs/research/00-synthesis.md): principles, reference architecture, build order, open decisions.
- [Terminal harness requirements](docs/research/10-terminal-harness.md): what "usable like Claude Code" means, feature by feature.
- [Competitive landscape](docs/research/11-competitive-landscape.md): what Claude Code, Codex CLI, Gemini CLI, OpenCode, Aider and others get right and wrong.

Every claim is cited to [`docs/research/sources.csv`](docs/research/sources.csv), which is mirrored to the project's Google Sheet.

## Repository layout
```
docs/
  usage/           how to use teh
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

## Using teh
- [Interactive use](docs/usage/interactive.md): the terminal UI, model choice, trust, modes, the settings panel, tools and subagents.
- [Permissions and the sandbox](docs/usage/permissions-and-sandbox.md): what runs without asking, rules, trust and the OS sandbox.
- [Extensions](docs/usage/extensions.md): output styles, hooks, MCP servers, skills and commands.
- [Sessions, rewind and checkpoints](docs/usage/sessions-and-checkpoints.md): continuing, rewinding and undoing, plus other flags.

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[Apache License 2.0](LICENSE). Contributions are accepted under the same license (section 5 of the license).
