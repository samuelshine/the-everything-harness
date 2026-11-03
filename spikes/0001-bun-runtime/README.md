# Spike 0001: Bun runtime validation

Throwaway code that tests [ADR-0001](../../docs/adr/0001-language-runtime-and-distribution.md) before it is accepted. Nothing here is production code; delete the folder once the ADR is decided.

## What it checks
| # | ADR check | How |
|---|---|---|
| 1 | Compiled binary on 3 OSes; size and cold start | `bun build --compile`; `spike all` spawns itself 20× with `noop` and reports median/p90 |
| 2 | Flicker-free inline rendering | `src/render.ts`: inline differential renderer (diffed live region + DEC 2026 synchronized output) vs naive full redraw. Bytes and frames are automated; **flicker is judged by eye** with `spike render-demo` |
| 3 | Sandboxed bash, network denied | `src/sandbox.ts`: `sandbox-exec` (macOS) / `bwrap --unshare-net` (Linux). Checks writes inside the workspace succeed, writes outside fail, curl fails, reads work. Windows is out of scope |
| 4 | MCP + Anthropic/OpenAI SDKs inside the binary | `src/sdk.ts`: compiled MCP client ↔ compiled stdio MCP server; provider SDKs make a live call when `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` are set, otherwise they prove the request reaches the transport layer |

## Run
```bash
npm ci --ignore-scripts          # installs pinned deps incl. bun 1.4.3 locally
export PATH="$PWD/node_modules/.bin:$PATH"
bun run spike                    # build both binaries, run all checks, print JSON
./dist/spike render-demo         # watch for flicker; add --naive to compare
```
CI runs the same checks on Ubuntu, macOS and Windows: `.github/workflows/spike-0001.yml`.

## Results

### macOS 26 (arm64), local, 2026-11-02, Bun 1.4.3
| Check | Result |
|---|---|
| 1. Binary | 69.6 MiB; cold start **36.7 ms median**, 37.5 ms p90 (target < 300 ms) ✅ |
| 2. Render (5,000 lines, 30,001 frames, 9-line live region) | Inline diff wrote **4.3 MiB** vs naive **8.3 MiB** (−49%). Manual flicker check: see below |
| 3. Sandbox (`sandbox-exec`) | Write inside ✅ · write outside denied ✅ · network denied ✅ · reads ✅ |
| 4. SDKs | MCP stdio client↔server ✅ · Anthropic SDK ✅ (no key: transport only) · OpenAI SDK ✅ (no key: transport only) |

### CI (GitHub-hosted runners), run 41410693780, Bun 1.4.3
| Runner | Binary | Cold start median / p90 | Sandbox | SDKs + MCP |
|---|---|---|---|---|
| macOS (arm64) | 69.6 MiB | 52.1 / 62.3 ms | ✅ all 4 | ✅ |
| Ubuntu (x64, bwrap) | 88.6 MiB | 114.9 / 153.1 ms | ✅ all 4 | ✅ |
| Windows (x64) | 93.9 MiB | 70.8 / 86.7 ms | skipped (out of scope) | ✅ |

Renderer numbers are identical on every OS (4.3 MiB inline vs 8.3 MiB naive), as expected, since they are computed rather than measured on a terminal. All cold starts are well under the 300 ms target. CI runners are noisier and slower than a local machine.

### Manual flicker check (`render-demo`, 1,000 lines, 5 ms delay)
| Terminal | Inline differential | Naive full redraw | Date |
|---|---|---|---|
| macOS Terminal.app | ✅ Stable, no visible flicker | ❌ Visibly glitchy | 2026-11-03 |

### Still to do by hand
- `render-demo` in iTerm2, VS Code's terminal, tmux and Windows Terminal (optional; Terminal.app passes).
- Live provider calls with real API keys.

## Findings so far
- **Binary size (~70 MiB)** is the main cost of Bun `--compile`, because it embeds the runtime. Probably acceptable for a CLI, but worth tracking. Two binaries means ~140 MiB; ship one binary with subcommands in the real product.
- **macOS sandbox profiles need real paths.** `/var` → `/private/var` symlinks made the workspace write fail until the paths were resolved with `realpath`. The real sandbox layer must canonicalise every path before generating policy.
- **Linux needs unprivileged user namespaces.** Ubuntu 24.04 restricts them via AppArmor, so the workflow relaxes `kernel.apparmor_restrict_unprivileged_userns`. Real users on such distros will hit this. The harness must detect it and explain the fix, or fall back to a container.
- **Windows has no sandbox story yet.** That is expected (doc 10 §4) and needs its own ADR.
- **The renderer difference is visible, not just measurable.** In Terminal.app the naive full redraw looks glitchy, and the inline differential renderer looks stable. This supports building our own renderer (ADR-0001 guard rail) rather than redrawing the whole live region.
- The diffing renderer roughly halves terminal writes with a realistic live region (stream line + spinner + to-do panel + status). Its benefit grows with live-region size.
