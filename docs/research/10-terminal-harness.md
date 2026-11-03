# 10 — The terminal harness: what "usable like Claude Code" requires

*Scope: everything a terminal-first coding agent needs beyond the model loop, from process architecture and tools to permissions, checkpoints, TUI rendering, config, headless mode, distribution and cross-platform support. Competitor strengths and failures are in [11 — Competitive landscape](11-competitive-landscape.md).*

---

## 1. What we are building

A **terminal-first agent** that someone who uses Claude Code daily could switch to without losing workflow. That means the same mental model:
- start it in a repo;
- talk to it;
- it reads, edits and runs things under rules you control;
- you can interrupt, rewind, resume, script it and extend it.

The bar is set by Claude Code [TRM-01, TRM-02], Codex CLI [TRM-18] and Gemini CLI [TRM-21]. The counter-example that shows how small the core can be is pi [TRM-32].

**Architecture rule:** build the **engine as a library with an event protocol**. The TUI is the first client. Headless (`-p`), ACP for editors [MCP-12], and a local server [CMP-20] are the others. Claude Code runs one engine behind the CLI, IDE, desktop and cloud surfaces [TRM-01, TRM-03]. OpenCode makes the TUI just one client of a server [CMP-20]. Codex moved to a wire protocol so extensions can be written in any language [CMP-15].

```
          ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌───────────┐
clients   │   TUI    │ │ headless  │ │ ACP/IDE  │ │ HTTP/WS   │
          └────┬─────┘ └─────┬─────┘ └────┬─────┘ └─────┬─────┘
               └──── typed event stream (JSONL) ────────┘
          ┌────────────────────────▼──────────────────────────┐
engine    │ session mgr · loop · tools · permissions · sandbox │
          │ context/memory · checkpoints · hooks · MCP · skills│
          │ provider layer (doc 02) · telemetry (doc 09)       │
          └───────────────────────────────────────────────────┘
```

---

## 2. Capability checklist (priority-tagged)

`P0` = MVP (a Claude Code user would not tolerate its absence) · `P1` = expected within a few releases · `P2` = differentiator or polish.

### A. Session lifecycle
| Capability | Pri | Notes / evidence |
|---|---|---|
| Start in cwd, detect git root, **workspace-trust prompt** on first run in a folder | P0 | Repo-supplied allow rules, env and MCP servers must wait for trust [TRM-03]. Codex defaults non-git folders to read-only [TRM-19]. |
| Auth: API keys per provider, env vars, key helper command, OS keychain | P0 | BYO key is a positioning advantage [CMP-04, CMP-05]. |
| `/init` generates `AGENTS.md` (read `CLAUDE.md`/`GEMINI.md` as aliases) | P0 | AGENTS.md is the cross-vendor standard [SKL-07]; OpenCode, Codex and others use it [CMP-20]. |
| Sessions persisted as **append-only JSONL** (messages, tool calls, results, checkpoints, cost) | P0 | Gives continue, resume, fork, audit and evals for free. pi documents its format for post-processing [TRM-32]. |
| `-c` continue, `-r` resume by id/name, `/resume` picker, **fork/branch** a session | P0/P1 | [TRM-07, TRM-32] |
| Session naming, cleanup policy (retention days), export/share | P1/P2 | Amp's shared threads are a loved feature [CMP-25]. |

### B. The loop (interactive behaviour)
| Capability | Pri | Notes |
|---|---|---|
| Streaming text, thinking and tool-call rendering | P0 | |
| **Esc interrupts without losing work**; agent keeps partial results | P0 | [TRM-08] |
| **Message queueing / steering** while the agent works | P0 | Typing while it runs is core UX [TRM-08]. |
| To-do list tool shown in the status area | P0 | Keeps the plan near the end of context. Factory credits a planning tool [CMP-16]. |
| **Plan mode** (read-only exploration → proposed plan → approve) | P0 | Every major tool has it [TRM-04, CMP-20, CMP-23, CMP-26]. pi uses PLAN.md files instead, which is also valid [TRM-32]. Persist the plan to a file either way. |
| Model switch and effort/thinking toggle mid-session | P0 | Warn that switching models drops the prompt cache [TRM-03]. Effort defaults matter: lowering the default effort was a quality regression [CMP-02]. |
| Max turns, per-session budget (tokens/$), hard stop | P1 | Cost surprises drove backlash [CMP-05]. |
| Background tasks (long bash, dev servers, subagents) with a `/tasks` view, kill and cleanup | P1 | Factory's background primitive tracks spawned processes for cleanup [CMP-16]. pi's critique: background bash is opaque and forgotten after compaction, so show it and persist it [TRM-32]. |
| Runtime awareness: elapsed time, short default timeouts with opt-in long ones | P1 | Factory's speed gains came partly from this [CMP-16]. |

### C. Built-in tools
Minimal set first. Tool quality beats tool count [MCP-05, OTH-08, CMP-16, TRM-32].

| Tool | Pri | Design notes |
|---|---|---|
| `read` (line ranges, images, PDFs, notebooks) | P0 | Line numbers in output. Truncate with a "use offset" hint. Track reads for stale-file checks. |
| `edit` | P0 | See §3. Refuse to edit a file that wasn't read or changed on disk since it was read. |
| `write` | P0 | Same read-before-overwrite rule. |
| `bash` | P0 | Persistent cwd. Timeouts. Exit code always surfaced. Output head/tail truncation. Runs in the sandbox (§4). |
| `grep` (ripgrep), `glob` | P0 | Ripgrep is faster and its output is model-friendly [CMP-16]. Respect .gitignore. |
| `todo` | P0 | |
| `web_fetch`, `web_search` | P1 | Fetched content is **untrusted** (taint it) [OTH-01]. |
| `agent` / `task` (subagents) | P1 | Make subagent work visible; it was criticised as "a black box within a black box" [TRM-32]. See doc 08. |
| LSP diagnostics after edits | P1 | OpenCode and Crush feed LSP errors back to the model [CMP-20, CMP-28]. It is a cheap, strong feedback signal (doc 07). |
| Repo map (tree-sitter symbol ranking) | P2 | Aider's approach [TRM-23, TRM-24]. |
| Notebook edit, image/screenshot input | P2 | |

**Environment bootstrap.** At session start, inject OS, shell, languages, git status and the repo tree summary, formatted as if it were shell output. That cut redundant exploration calls for Factory [CMP-16].

### D. Interface details users notice immediately
| Capability | Pri |
|---|---|
| `/` commands with autocomplete; user/project commands as markdown files [TRM-09] | P0 |
| `@file` mentions with fuzzy path completion; `!` shell mode (output added to context) [TRM-08] | P0 |
| Multiline input, paste (bracketed paste), image paste, history + Ctrl-R search, external editor (Ctrl-G) [TRM-08] | P0 |
| Diff display for every edit (coloured unified diff, collapsed by default) | P0 |
| `/cost` and a live **context-usage meter** | P0 |
| `/compact`, `/clear`, `/rewind`, `/model`, `/config`, `/permissions`, `/mcp`, `/agents`, `/doctor`, `/bug` | P0/P1 |
| Rebindable keybindings, vim mode, themes, status line script [TRM-10, TRM-34] | P1/P2 |
| Desktop notification / terminal bell when a long task finishes or needs approval | P1 |

---

## 3. Editing files reliably

Edits are where terminal agents most often fail silently. Recommended design:

1. **One `edit` tool, multiple wire formats, chosen per model** through capability flags (doc 02):
   - **Exact string replace** (`old_string` → `new_string`, must be unique, with `replace_all`) is Claude-native [TRM-33].
   - **`apply_patch` (V4A)** is the format OpenAI models are trained on [TRM-26, TRM-18].
   - **Search/replace blocks, unified diff, whole file** are Aider's set; the best format is model-dependent [TRM-22, CMP-22]. Factory tailors edit formats per model [CMP-16].
2. **Validation pipeline:** parse → locate (exact first, then whitespace-normalised fuzzy fallback with a confidence threshold) → apply to an in-memory buffer → write atomically (temp file and rename). On mismatch, return an **actionable error** with the nearest candidate lines, not a bare "failed".
3. **Stale-file protection:** record mtime and hash on read, and reject edits if the file changed underneath.
4. **Post-edit hooks:** formatter, linter, LSP diagnostics. Return results to the model (doc 07).
5. **Speed path (P2):** a separate fast "apply model" or provider predicted outputs for big rewrites [TRM-25, PERF-13].

---

## 4. Permissions, sandbox and trust

This is the most security-critical subsystem. Most real-world incidents in doc 11 are failures here [CMP-06, CMP-07, CMP-08, CMP-10, CMP-12, CMP-13].

**Two independent axes** (from Codex [TRM-19]), plus rules (from Claude Code [TRM-04]):

| Axis | Values |
|---|---|
| **Sandbox mode**: what the OS allows | `read-only` · `workspace-write` (default in git repos) · `full-access` |
| **Approval mode**: when we ask | `default/manual` · `accept-edits` · `plan` (read-only) · `auto` (classifier/reviewer agent reviews risky actions) · `bypass` |
| **Rules** | `deny` → `ask` → `allow`, first match wins, in that order regardless of specificity. Deny from any scope beats allow from any scope [TRM-04]. |

Requirements:
- **Parse shell commands into an AST** before matching rules. Handle `;`, `&&`, `|`, subshells, `$(…)`, `sh -c`, `xargs`, `find -exec`, wrappers (`env`, `timeout`, `nice`) and redirections.
  - Root-command prefix matching is the recurring bypass class: Gemini CLI's `grep …; exfil` [CMP-07] and Claude Code CVEs [CMP-13, CMP-14].
  - Maintain a fuzz and regression corpus.
- **Render commands safely**: escape control characters, make long whitespace runs visible, never truncate the dangerous tail. A long whitespace run hid Tracebit's payload [CMP-07].
- **OS sandbox for bash and stdio MCP servers:**
  - macOS Seatbelt and Linux bubblewrap+seccomp, with network off or allow-listed via proxy [TRM-13, TRM-14, TRM-19, OTH-04].
  - Windows is materially harder; budget for it and test it [CMP-32].
- **Protected paths** stay read-only even in writable roots: `.git`, the harness's own config dir, `.agents`, credentials [TRM-19]. Agents rewriting their own permission config was a CVE class [CMP-13].
- **Workspace trust:** repo-supplied allow rules, env, hooks and MCP servers do nothing until the folder is trusted. Deny/ask rules apply immediately [TRM-03].
- **MCP config integrity:** hash each server's command/args/env and re-prompt on any change. Never auto-start newly added servers [CMP-12].
- **Bypass hardening:** `--yolo`-style flags should require an interactive confirmation or an explicit env/config opt-in, and still honour the sandbox and deny rules. Malware invoked installed agents with bypass flags to hunt secrets [CMP-10].
- **Destructive-op guard:** for `rm -rf`, `git reset --hard`, mass `mv`, DB `DROP`/`DELETE`, force-push:
  - snapshot first;
  - verify preconditions (did the `mkdir` succeed?) [CMP-06];
  - treat "code freeze" or "prod" as an enforced policy, not a prompt instruction [CMP-08].

---

## 5. Checkpoints, undo and git

- **Per-turn checkpoints** of every file the agent touches. Restore code, conversation or both (`Esc Esc` / `/rewind`) [TRM-05].
- **Close the bash gap.** Claude Code's checkpoints don't track bash-made changes [TRM-05]. Use a **shadow git repo / `git stash create` snapshot of the worktree per turn**, which captures everything regardless of which tool wrote it.
- **Git integration:**
  - optional auto-commit per accepted change (Aider [CMP-21]);
  - attribution trailers;
  - `/review` of the working diff;
  - PR creation via `gh`.
- **Worktree-per-session** as a first-class command for parallel agents [TRM-12]. Combine with "one writer per artifact" (synthesis principle 8).

---

## 6. Context management in a terminal agent

Applies doc 01 to the CLI:
- **Memory files:** a hierarchy of user (`~/.config/<harness>/AGENTS.md`), project (`AGENTS.md`, committed), local (gitignored), and nested per-directory files, with `@path` imports [CTX-18, SKL-07]. Show which files loaded (`/memory`).
- **Visible context:** a meter in the status line and a `/context` breakdown (system, tools, memory, history). pi's critique of harnesses that "inject content behind your back" is a trust issue; show everything [TRM-32].
- **Compaction:** auto at a threshold, plus manual `/compact [focus]`. Tool-result clearing first [CTX-02]. Persist the to-do list and background-task registry across compaction [TRM-32].
- **Cache discipline:** stable system prompt and tool order; never reorder tools mid-session [CTX-04, PERF-01].
  - The April 2026 Claude Code regression included a cache/thinking-clearing bug that fired every turn, which degraded quality and burned quota [CMP-02].
  - **Write cache-hit-rate tests.**

---

## 7. TUI rendering

| Approach | Pros | Cons | Who |
|---|---|---|---|
| **Inline, differential** (render into the normal screen, redraw only changed lines, synchronized output) | Native scrollback, selection, search, copy; works in tmux; feels like the user's terminal | Hard to get flicker-free; limited layout | Claude Code (rewritten renderer), Codex, pi [TRM-31, TRM-32] |
| **Alternate screen** (full-screen app) | Full layout control, no flicker | Breaks native find, selection and scrollback; needs custom scrollbar/search; terminal compatibility issues | Amp, OpenCode (opentui); Gemini CLI tried it and **rolled it back within ~a week** [TRM-31]; Claude Code offers it opt-in [TRM-16] |

**Recommendation:**
- Make **inline differential the default** and alternate screen an opt-in.
- Implementation specifics:
  - retained component tree with cached line output;
  - diff by line;
  - wrap frames in synchronized-update escape sequences (DEC mode 2026);
  - bracketed paste;
  - OSC 8 hyperlinks;
  - OSC 52 clipboard;
  - Kitty keyboard protocol when available.
- If TypeScript: the React component model is fine (Ink [TRM-27]), but **own the renderer backend**. Anthropic kept React and rewrote the renderer [TRM-31]. Rust: Ratatui [TRM-28]. Go: Bubble Tea [TRM-29]. Python: Textual [TRM-30].
- Test matrix:
  - macOS Terminal, iTerm2, Ghostty, Kitty, WezTerm, Alacritty;
  - VS Code / JetBrains terminals;
  - Windows Terminal;
  - tmux and screen, over SSH.
  - Flicker under tmux is still a reported issue for Claude Code [TRM-31].
- Accessibility: `NO_COLOR`, a plain/screen-reader mode, and no information conveyed by colour alone.

---

## 8. Configuration

Copy the Claude Code scope model [TRM-03]: **managed > CLI flags/`--settings` > project-local > project-shared > user**.
- Lists merge across scopes.
- Restrictive values win in a few security keys.
- Hot-reload on file change.
- Publish a JSON Schema for editor autocomplete.
- `bypass`/`auto` modes cannot be set from repo files.

Codex-style **profiles** (named bundles of provider + model + sandbox + approval) are a nice addition [TRM-20]. `/doctor` should report which files loaded and which entries were rejected [TRM-03].

---

## 9. Extensibility (cross-references)

| Surface | Format | Doc |
|---|---|---|
| Slash commands | Markdown + frontmatter (`$ARGUMENTS`), same loader as skills | [TRM-09], 05 |
| Skills | `SKILL.md` (Agent Skills spec), progressive disclosure | 05 |
| Hooks | Lifecycle events → shell/HTTP; exit code 2 blocks; cannot override deny | [FBK-10, TRM-04], 07 |
| MCP | stdio/HTTP client with OAuth; sandboxed stdio; tool search | 06 |
| Plugins | Bundle of commands/skills/hooks/agents/MCP + marketplace | 06 |
| Subagents | Markdown agent definitions with tools/model allowlists | 08 |
| Output styles & status line | System-prompt fragments; stdin-JSON status script | [TRM-10, TRM-11] |

---

## 10. Headless and automation

- `harness -p "task"` with `--output-format text|json|stream-json` and `--input-format stream-json` [TRM-06].
- Stable **event schema** (the same events the TUI consumes).
- Meaningful **exit codes**.
- `--max-turns`, `--allowed-tools`, `--permission-mode`, `--append-system-prompt` [TRM-07].
- CI recipes: a GitHub Action, pre-commit review, issue triage.
- Headless is also how we run evals (Harbor/Terminal-Bench [OTH-11, CMP-17]) and fan-out (doc 08).

## 11. IDE, remote and other surfaces
- **ACP server mode**, so Zed, JetBrains and Neovim can host the agent [MCP-12, CMP-30]. A VS Code extension can be a thin ACP or local-server client [TRM-17].
- Remote: works over SSH; optional server mode (OpenCode-style [CMP-20]) to drive a session from another device.
- **Other agents as backends:** the user's installed Claude Code (headless `-p` stream-json [TRM-06] or ACP) and Codex (app-server) can run delegated tasks under their own subscription logins. This is how Claude subscribers use their plan with us. See [02](02-multi-llm-providers.md#authentication-and-subscriptions) and [ADR-0009](../adr/0009-provider-auth-and-subscriptions.md).

## 12. Observability, cost and support
- `/cost`, a per-session ledger, and provider cache hit/miss stats (doc 03).
- OTel export (opt-in) using GenAI semconv [OTH-07, TRM-15].
- `/bug` that bundles a redacted session for reporting. Anthropic's postmortems stress user feedback paths, because evals missed the regressions [CMP-01].
- **Versioned system prompt and defaults.** Every change to them ships with an eval run and a changelog entry [CMP-02, CMP-03].

## 13. Distribution and updates
- **Single binary** with no runtime prerequisite. Codex rewrote in Rust largely for zero-dependency install [CMP-15]. With TypeScript, use `bun build --compile` or a Node single-executable application.
- Install via curl script, Homebrew, npm, winget.
- `update` command, stable/latest channels, version pinning [TRM-07].
- Fast startup (< 300 ms to prompt) and lazy-loaded MCP/skills.
- Telemetry off by default, or clearly disclosed (Codex defaults OTel off [TRM-19]).

---

## 14. Recommended MVP cut (maps to synthesis build order)

1. **Engine + JSONL session store + event protocol**, with headless `-p` first. It is the easiest client to test.
2. **Provider layer** with 2–3 native adapters (doc 02).
3. **Tools:** read/write/edit (2 formats)/bash/grep/glob/todo, plus stale-file checks.
4. **Permission engine** (shell AST parser) + **sandbox** (macOS + Linux) + workspace trust.
5. **TUI v1:** inline differential renderer, input editor, slash commands, diff view, interrupt and queueing, context/cost meter.
6. **Checkpoints** (shadow-git), resume/continue, plan mode, AGENTS.md loading, `/init`, `/compact`.
7. Then hooks, MCP, skills, subagents, ACP, plugins (docs 05–08).

### Decision update for synthesis §5.1 (language)
A terminal-first product raises the weight of **single-binary distribution, startup time and sandbox bindings** [CMP-15]:
- **TypeScript + Bun (compiled):** fastest path, matches Claude Code, Gemini CLI and OpenCode, and has the best MCP/ACP SDKs. Downsides: you must own the renderer, and native sandbox bindings come via spawn (sandbox-exec/bwrap), which works.
- **Rust:** Codex's choice. Best binary, startup and sandbox story; slower iteration; thinner AI SDK ecosystem.
- *Lean:* **TypeScript on Bun** for velocity, with a strict engine/TUI split and a language-neutral event protocol so a Rust core stays possible later.

## Open questions
- ~~Do we support subscription logins, or BYO keys only?~~ Resolved in [ADR-0009](../adr/0009-provider-auth-and-subscriptions.md): ChatGPT plan via Sign in with ChatGPT (open-source route); Claude subscriptions only by delegating to the user's own Claude Code.
- Default approval mode: `default` (prompts), or sandboxed `auto` with a reviewer agent [TRM-19]?
- How much of Claude Code's CLI flag surface do we mirror verbatim to ease switching?

<!-- SOURCES:TRM -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| TRM-01 | [Claude Code overview](https://code.claude.com/docs/en/overview) | Anthropic | 2026 | Must read |
| TRM-02 | [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) | Anthropic | 2026 | Must read |
| TRM-03 | [Claude Code settings files and precedence](https://code.claude.com/docs/en/settings) | Anthropic | 2026 | Must read |
| TRM-04 | [Claude Code permissions (rules, modes, precedence)](https://code.claude.com/docs/en/permissions) | Anthropic | 2026 | Must read |
| TRM-05 | [Checkpointing (rewind code and/or conversation)](https://code.claude.com/docs/en/checkpointing) | Anthropic | 2026 | Must read |
| TRM-06 | [Headless mode / Agent SDK CLI (-p, stream-json)](https://code.claude.com/docs/en/headless) | Anthropic | 2026 | Must read |
| TRM-07 | [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference) | Anthropic | 2026 | Should read |
| TRM-08 | [Claude Code interactive mode (shortcuts, input modes)](https://code.claude.com/docs/en/interactive-mode) | Anthropic | 2026 | Must read |
| TRM-09 | [Slash commands](https://code.claude.com/docs/en/slash-commands) | Anthropic | 2026 | Should read |
| TRM-10 | [Status line](https://code.claude.com/docs/en/statusline) | Anthropic | 2026 | Optional |
| TRM-11 | [Output styles](https://code.claude.com/docs/en/output-styles) | Anthropic | 2026 | Optional |
| TRM-12 | [Common workflows (worktrees, parallel sessions, images, resume)](https://code.claude.com/docs/en/common-workflows) | Anthropic | 2026 | Should read |
| TRM-13 | [Claude Code sandboxing docs](https://code.claude.com/docs/en/sandboxing) | Anthropic | 2026 | Must read |
| TRM-14 | [anthropics/sandbox-runtime](https://github.com/anthropics/sandbox-runtime) | Anthropic | 2025 | Must read |
| TRM-15 | [Claude Code monitoring (OpenTelemetry)](https://code.claude.com/docs/en/monitoring-usage) | Anthropic | 2026 | Should read |
| TRM-16 | [Claude Code fullscreen rendering](https://code.claude.com/docs/en/fullscreen) | Anthropic | 2026 | Should read |
| TRM-17 | [Claude Code in VS Code (IDE integration)](https://code.claude.com/docs/en/vs-code) | Anthropic | 2026 | Optional |
| TRM-18 | [OpenAI Codex CLI (open-source, Rust)](https://github.com/openai/codex) | OpenAI | 2026 | Must read |
| TRM-19 | [Codex sandbox and approvals](https://learn.chatgpt.com/docs/agent-approvals-security) | OpenAI | 2026 | Must read |
| TRM-20 | [Codex config reference](https://learn.chatgpt.com/docs/config-file/config-reference) | OpenAI | 2026 | Should read |
| TRM-21 | [Gemini CLI (open-source)](https://github.com/google-gemini/gemini-cli) | Google | 2026 | Should read |
| TRM-22 | [Aider edit formats](https://aider.chat/docs/more/edit-formats.html) | Aider | 2026 | Must read |
| TRM-23 | [Aider repository map (tree-sitter)](https://aider.chat/docs/repomap.html) | Aider | 2026 | Should read |
| TRM-24 | [Building a better repository map with tree-sitter](https://aider.chat/2023/10/22/repomap.html) | Aider (Paul Gauthier) | 2023-10-22 | Optional |
| TRM-25 | [Editing files at 1000 tokens per second (Instant Apply)](https://cursor.com/blog/instant-apply) | Cursor (Anysphere) | 2024 | Should read |
| TRM-26 | [GPT-4.1 prompting guide (apply_patch diff format)](https://developers.openai.com/cookbook/examples/gpt4-1_prompting_guide) | OpenAI | 2025 | Must read |
| TRM-27 | [Ink (React for CLIs)](https://github.com/vadimdemedes/ink) | Vadim Demedes | 2026 | Should read |
| TRM-28 | [Ratatui (Rust TUI)](https://ratatui.rs) | Ratatui | 2026 | Optional |
| TRM-29 | [Bubble Tea (Go TUI)](https://github.com/charmbracelet/bubbletea) | Charm | 2026 | Optional |
| TRM-30 | [Textual (Python TUI)](https://textual.textualize.io) | Textualize | 2026 | Optional |
| TRM-31 | [The signature flicker (terminal rendering for coding agents)](https://steipete.me/posts/2025/signature-flicker) | Peter Steinberger | 2025-12 | Must read |
| TRM-32 | [What I learned building an opinionated and minimal coding agent (pi)](https://mariozechner.at/posts/2025-11-30-pi-coding-agent/) | Mario Zechner | 2025-11-30 | Must read |
| TRM-33 | [Claude Code tools reference](https://code.claude.com/docs/en/tools-reference) | Anthropic | 2026 | Should read |
| TRM-34 | [Keybindings](https://code.claude.com/docs/en/keybindings) | Anthropic | 2026 | Optional |
<!-- /SOURCES -->
