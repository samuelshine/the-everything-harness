# the-everything-harness

A model-agnostic, **terminal-first** agent harness. You should be able to use it the way you use Claude Code: start it in a repo, talk to it, and let it read, edit and run things under rules you control. It handles context, tools, memory, skills, plugins/MCP, delegation, verification and safety, and works across LLM providers.

## Status
**Early development.** The workspace is set up (Bun + TypeScript, ADR-0001); the agent itself is not built yet. Background reading:
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
  cli/             `harness` entrypoint, headless mode, flags
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
bun run build        # compile packages/cli/dist/harness
bun packages/cli/src/main.ts --help   # run from source
```

## Contributing
See [CONTRIBUTING.md](CONTRIBUTING.md).

## License
[Apache License 2.0](LICENSE). Contributions are accepted under the same license (section 5 of the license).
