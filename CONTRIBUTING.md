# Contributing

## Branches
- `main` is always releasable (once there is something to release). Never commit to it directly; changes land through pull requests.
- Use short-lived topic branches cut from `main`, named `<type>/<short-description>`:

  | Prefix | Use for |
  |---|---|
  | `feat/` | New functionality |
  | `fix/` | Bug fixes |
  | `docs/` | Documentation only |
  | `research/` | Research write-ups and source catalogue updates (`docs/research/`) |
  | `refactor/` | Code changes with no behaviour change |
  | `test/` | Tests and evals only |
  | `chore/` | Tooling, CI, dependencies, repo hygiene |

- There is no long-lived `research` or `develop` branch. Each research pass gets its own `research/...` branch, merges to `main`, and is deleted, the same as feature work. Long-lived side branches drift and turn every merge into a conflict.
- Rebase on `main` before opening a PR, and prefer **squash or rebase merges** so `main` history stays linear.

## Commits
Use [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <summary in imperative mood>

<optional body: what and why>
```

- Types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`, `build`, `ci`.
- Scopes (initial): `research`, `adr`, `core`, `tui`, `cli`, `sandbox`, `providers`, `evals`.
- Keep each commit to one logical change that builds and passes on its own.

## Pull requests
- One topic per PR, with a description that says what changed, why, and how it was verified.
- Link the ADR when a PR implements or changes an architectural decision.

## Development
- Toolchain: Bun 1.4.3 (runtime, package manager, test runner, compiler), TypeScript 7 in strict mode for type checking, Biome for lint and format. See [ADR-0001](docs/adr/0001-language-runtime-and-distribution.md).
- Run `bun run check` before pushing; CI runs the same checks, plus a compiled-binary smoke test, on Linux, macOS and Windows.
- `bun run format` fixes formatting and import order. Biome is configured to leave Markdown alone.
- Packages live in `packages/<name>` with `src/` and `test/`; tests are `*.test.ts` using `bun:test`. Workspace packages import each other by name (`@everything-harness/core`), never by relative path.
- Keep `packages/core` free of terminal and process globals so every client (CLI, TUI, ACP, server) can share it.

## Decisions
Significant technical choices are recorded as ADRs in [`docs/adr/`](docs/adr/README.md). Open a new ADR from the template rather than editing an accepted one; supersede it instead.

## Research docs
- `docs/research/sources.csv` is the source of truth for citations. Cite sources as `[PREFIX-NN]`.
- After editing the CSV, run `python3 docs/research/tools/fill_sources.py` to regenerate each doc's source table. It is idempotent, so a second run should print nothing.
- Mirror new rows to the Google Sheet ("All sources" plus the topic tab).
