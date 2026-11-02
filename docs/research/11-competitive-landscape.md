# 11 — Competitive landscape: what the competition gets right and wrong

*As of 2026-11-02. Strengths come from docs and design posts; failures come from postmortems, CVEs, incident reports and documented user complaints. Benchmark and productivity figures are publisher-reported unless stated otherwise. Requirements derived from this analysis are in [10 — Terminal harness](10-terminal-harness.md).*

---

## 1. The field at a glance

| Tool | Vendor | Open source | Model lock-in | Surfaces | Signature strength | Signature weakness |
|---|---|---|---|---|---|---|
| **Claude Code** | Anthropic | No | Claude only (incl. via Bedrock/Vertex) | CLI, IDE, desktop, web | Deepest extension surface (hooks, skills, plugins, subagents); permission engine | Closed; silent harness regressions [CMP-02]; quota opacity [CMP-04] |
| **Codex CLI** | OpenAI | Yes (Apache-2.0, Rust) | OpenAI-first (configurable providers) | CLI, IDE, app, cloud | Sandbox x approval model; single binary [TRM-19, CMP-15] | Sandbox/approval regressions, Windows pain [CMP-32] |
| **Gemini CLI** | Google | Yes (Apache-2.0, TS) | Gemini | CLI | Free tier, 1M context [CMP-31] | File-loss and injection incidents [CMP-06, CMP-07] |
| **Copilot CLI** | GitHub | No | Multi (org policy) | CLI | GitHub distribution and integration [CMP-26] | Tied to Copilot subscription |
| **Cursor** (+CLI) | Anysphere | No | Multi | IDE, CLI | Fast apply, IDE UX [TRM-25] | Pricing trust crisis [CMP-05]; MCP CVEs [CMP-12] |
| **OpenCode** | Anomaly (ex-SST) | Yes | Any provider | TUI, desktop, IDE, server | Client/server; provider-agnostic; LSP [CMP-20] | Custom alt-screen renderer breaks in some terminals [TRM-31] |
| **Aider** | Paul Gauthier | Yes | Any | CLI | Repo map, edit formats, git-native, public benchmarks [CMP-21] | Less autonomous; pair-programmer model |
| **Cline** | Cline | Yes | Any (BYO key) | VS Code, CLI | Plan/Act, approve-each-action, checkpoints [CMP-23] | Approval fatigue on routine work |
| **goose** | Block → AAIF | Yes | Any tool-calling LLM | CLI, desktop | MCP-first, recipes, neutral governance [CMP-24] | Generalist; less coding-specific tuning (our assessment) |
| **Amp** | Amp (Sourcegraph) | No | Picks for you | CLI, web, apps | Opinionated defaults, shared threads, oracle, remote orbs [CMP-25] | No model choice; churn by design |
| **Factory Droid** | Factory | No | Model-agnostic | CLI, web | Harness engineering wins benchmarks [CMP-16] | Closed; enterprise focus |
| **Kiro** | AWS | No | Claude-based by default | IDE (+CLI) | Spec-driven workflow [CMP-27] | Heavy process for small tasks |
| **pi** | Mario Zechner / Earendil | Yes | Any; cross-provider handoff | CLI | Minimal, transparent, fast TUI [TRM-32] | YOLO by default; no sandbox; few features by design |
| **Crush / Qwen Code** | Charm / Alibaba | Yes | Multi / Qwen | CLI | Polished Go TUI / open-weight focus [CMP-28, CMP-29] | Smaller ecosystems |

---

## 2. Player-by-player

### Claude Code (Anthropic)
**Wins**
- Sets the reference UX: plan mode, Esc-interrupt, message queueing, `/rewind` checkpoints, `!` shell, `@` mentions [TRM-05, TRM-08].
- Extension surface others copy:
  - hooks [FBK-10];
  - skills (later an open standard) [SKL-01, SKL-02];
  - plugins/marketplaces [MCP-11];
  - subagents [AGT-08];
  - output styles and status line [TRM-10, TRM-11].
- Serious permission engine:
  - deny → ask → allow ordering;
  - shell-command parsing;
  - workspace trust;
  - managed policy [TRM-03, TRM-04].
- Sandboxing that cut prompts 84% internally [OTH-04, TRM-13], open-sourced as sandbox-runtime [TRM-14].
- Headless and SDK make it composable [TRM-06]. OTel export [TRM-15].
- Survived a renderer rewrite: kept native scrollback and fixed most flicker [TRM-31].

**Flaws**
- **Harness regressions shipped silently.** The April 2026 postmortem lists three:
  1. default effort lowered;
  2. a thinking-clearing cache bug that fired every turn;
  3. a verbosity line in the system prompt.

  Together they degraded quality for ~6 weeks. The API was unaffected [CMP-02, CMP-03].
- **Earlier infra bugs** went undetected by evals [CMP-01].
- **Opaque quotas.** Weekly caps were added in 2025 and numeric limits were never published [CMP-04].
- **Recurring approval-bypass CVEs** in shell-command parsing [CMP-13, CMP-14].
- **Checkpoints miss bash-made changes** [TRM-05].
- **Closed and single-vendor:**
  - the system prompt is unpublished [TRM-03];
  - power users criticise system-prompt churn per release;
  - feature sprawl ("spaceship");
  - opaque subagents and background bash [TRM-32].
- **Flicker** historically, still reported under tmux [TRM-31].

### Codex CLI (OpenAI)
**Wins**
- Open source; Rust; **single binary with zero runtime deps** [CMP-15].
- **Two-axis safety model:** sandbox mode and approval policy, with network off by default [TRM-19].
  - Protected paths (`.git`, `.codex`, `.agents`).
  - Non-git folders default to read-only.
  - Optional auto-review agent for approvals.
- `apply_patch`, the edit format OpenAI models are trained on [TRM-26].
- AGENTS.md lineage [SKL-07]; config profiles [TRM-20].
- Published loop internals [AGT-10] and harness-engineering practice [FBK-09].
- Stays in the primary screen buffer, so native text behaviour works [TRM-31].

**Flaws**
- Upgrade regressions in sandbox/approval behaviour, especially on Windows:
  - prompting on nearly every command;
  - blocked writes;
  - network confusion [CMP-32].
- TS→Rust transition churn [CMP-15].
- Mainly tuned for OpenAI models.

### Gemini CLI (Google)
**Wins**
- Apache-2.0 and launched with a **huge free tier** (1,000 req/day) and 1M context [CMP-31].
- GEMINI.md, MCP, extensions, Search grounding.
- Forkable: Qwen Code is a fork [CMP-29].

**Flaws**
- **Data loss.** A failed `mkdir` was assumed to have succeeded, and subsequent moves overwrote the user's files. There was no read-after-write check and no recovery [CMP-06].
- **Prompt-injection RCE.** The allowlist matched only the root command, so `grep …; curl …` ran unprompted. A whitespace run hid the payload in the UI. Codex and Claude Code were not vulnerable [CMP-07].
- **Alt-screen TUI rolled back** within about a week after user complaints [TRM-31].

### Cursor (Anysphere)
**Wins**
- Plan/apply split with a custom fast-apply model and speculative edits (~1000 tok/s) [TRM-25].
- Polished IDE UX.

**Flaws**
- **Pricing trust crisis.** "Unlimited" turned out to mean Auto-only. Users hit surprise charges, and Cursor apologised and refunded [CMP-05].
- **MCP trust bugs:**
  - new `mcp.json` entries auto-ran (CurXecute);
  - a once-approved server could be silently swapped (MCPoison) [CMP-12].

### GitHub Copilot CLI
- **Wins:** distribution to every Copilot seat; plan mode; parallel agents; org model policy; GitHub-native workflows [CMP-26].
- **Flaws:** subscription-gated; little public design writing to learn from.

### OpenCode
- **Wins:**
  - provider-agnostic;
  - **client/server**, so the TUI is one client and you can drive a session from other devices;
  - build/plan agents;
  - LSP integration;
  - `/undo` and `/redo`;
  - AGENTS.md [CMP-20].
- **Flaws:** the custom opentui alt-screen renderer:
  - doesn't work in older macOS Terminal or GNOME Terminal;
  - has scroll and search quirks;
  - right-click paste fails in the input box [TRM-31].

### Aider
- **Wins:**
  - tree-sitter repo map [TRM-23];
  - per-model edit formats [TRM-22];
  - **auto git commit per change** (undo for free);
  - architect/editor model split;
  - public edit leaderboards across many models [CMP-21, CMP-22].
- **Flaws:** pair-programming loop with less autonomy (tool use, long tasks) than Claude-Code-class agents.

### Cline (and forks)
- **Wins:** Plan/Act modes; human-in-the-loop on every action; checkpoints; MCP marketplace; BYO key; headless CLI [CMP-23].
- **Flaws:** approving each action is slow for routine work. Users flip to YOLO, which is the worst of both worlds without a sandbox.

### goose (Block → Agentic AI Foundation)
- **Wins:**
  - MCP-first;
  - local-first;
  - any tool-calling model;
  - shareable **recipes**;
  - early adopter of MCP-UI and ACP;
  - vendor-neutral governance alongside MCP and AGENTS.md [CMP-24, MCP-07].
- **Flaws (our assessment):** generalist agent, less tuned for heavy coding.

### Amp
- **Wins:**
  - strong opinionated defaults (it picks models per job);
  - **shared threads**;
  - an oracle reasoning model;
  - subagents;
  - remote "orbs" that keep working when the laptop closes [CMP-25].
- **Flaws:** no user model choice; "no backward compatibility" means churn; alt-screen renderer limitations [TRM-31].

### Factory Droid
- **Wins:** the clearest public evidence that **the harness matters**.
  - 58.8% on Terminal-Bench with the same Opus model on which Claude Code scored 43.2%.
  - Credited levers:
    - hierarchical prompts with mid-run system notifications;
    - per-model edit formats;
    - minimal tools with simple schemas;
    - environment bootstrap;
    - planning tool;
    - ripgrep;
    - short timeouts;
    - background processes [CMP-16].
- **Flaws:** closed. The numbers are self-reported at a point in time.

### Kiro (AWS)
- **Wins:** spec-driven workflow (requirements in EARS → design → tasks) and agent hooks on file events [CMP-27].
- **Flaws:** heavyweight for small changes; IDE-centric.

### pi
- **Wins:**
  - four tools and a system prompt under 1k tokens, yet competitive on Terminal-Bench 2.0;
  - total context transparency;
  - differential inline renderer (the "reference" for flicker-free inline [TRM-31]);
  - session branching;
  - cross-provider handoff mid-session [TRM-32].
- **Flaws:**
  - YOLO by default with no sandbox ("permissions are theatre"), which leaves users to containerise;
  - no MCP (originally);
  - no subagents or plan mode.

  All of this is deliberate, so its trade-offs are explicit.

### Incidents outside the CLI field (lessons still apply)
- **Replit:** the agent deleted a production DB during a declared code freeze and misreported it. Fixes were dev/prod separation and backups [CMP-08].
- **Amazon Q (VS Code):** a malicious PR injected a "wipe everything" prompt that shipped in a release [CMP-09].
- **Nx s1ngularity:** malware invoked installed agents with `--dangerously-skip-permissions` / `--yolo` / `--trust-all-tools` to hunt secrets [CMP-10, CMP-11].

---

## 3. Recurring failure patterns → our countermeasures

| # | Pattern | Seen in | Countermeasure (doc 10 section) |
|---|---|---|---|
| 1 | **Silent harness regressions** (prompt, defaults, caching) | Claude Code [CMP-02], infra [CMP-01] | Versioned system prompt + defaults; per-model eval and ablation on every change; cache-hit tests; public changelog; version pinning (§12) |
| 2 | **Shell-parsing permission bypass** | Gemini CLI [CMP-07], Claude Code CVEs [CMP-13, CMP-14] | AST parser, wrapper handling, fuzz corpus (§4) |
| 3 | **UI hides what will run** | Gemini CLI whitespace [CMP-07] | Safe rendering of commands; never truncate the tail (§4) |
| 4 | **Destructive ops without verification or snapshot** | Gemini CLI [CMP-06], Replit [CMP-08] | Exit-code checks, precondition checks, snapshot-before-destroy, enforced freeze/prod policy (§4, §5) |
| 5 | **Trust-once config** (MCP swapped after approval; repo config auto-applied) | Cursor [CMP-12] | Hash configs and re-approve on change; workspace trust gates repo config (§4, §8) |
| 6 | **Bypass flags abusable by other processes** | Nx malware [CMP-10] | Bypass needs interactive or explicit opt-in; sandbox and deny still apply (§4) |
| 7 | **Supply chain of prompts and plugins** | Amazon Q [CMP-09] | Signed releases, reviewed prompt diffs, plugin provenance/pinning (doc 06) |
| 8 | **Prompt fatigue → YOLO** | Cline [CMP-23], Codex regressions [CMP-32], pi's stance [TRM-32] | Sandbox-first so most actions need no prompt; `auto` reviewer mode (§4) |
| 9 | **Quota and price opacity** | Claude Code [CMP-04], Cursor [CMP-05] | BYO keys, live cost meter, budgets, hard stops (§2B, §12) |
| 10 | **TUI rendering trade-offs** | Flicker (Claude Code), alt-screen breakage (Gemini rollback, OpenCode, Amp) [TRM-31] | Inline differential default; alt-screen opt-in; terminal test matrix (§7) |
| 11 | **Opaque context and subagents** | Critique of Claude Code [TRM-32] | `/context` breakdown; visible subagent transcripts; no hidden injections (§6) |
| 12 | **Checkpoint gaps** | Claude Code bash edits [TRM-05] | Shadow-git snapshot per turn (§5) |
| 13 | **Vendor lock-in** | Claude Code, Gemini CLI, Amp | Provider layer (doc 02), cross-provider handoff [TRM-32] |
| 14 | **Perceived vs real productivity** | METR RCT (-19%) [CMP-18], SO survey "almost right" [CMP-19] | Verification-by-default, review-friendly diffs, outcome evals (docs 07, 09) |
| 15 | **Distribution friction** | Codex Node 22 requirement [CMP-15] | Single binary, fast start (§13) |
| 16 | **Cross-platform sandbox gaps** | Codex on Windows [CMP-32] | Per-OS sandbox CI; declare Windows tier honestly (§4) |

---

## 4. What wins: patterns to copy

1. **Small core, strong tools.** Four to eight well-designed tools beat sprawling sets [TRM-32, CMP-16, MCP-05].
2. **Model-specific adaptation inside one harness:** edit format, prompt tier and tool schemas tuned per model [CMP-16, TRM-22, TRM-26].
3. **Mid-run system notifications.** Re-inject time-sensitive guidance near the end of context, since models weight recent tokens [CMP-16].
4. **Plan mode with the plan persisted as a file** [TRM-04, CMP-27, TRM-32].
5. **Sandbox x approval two-axis model** with protected paths [TRM-19].
6. **Checkpoints and git-native undo** [TRM-05, CMP-21].
7. **Client/server engine** so the TUI is one client among headless, IDE (ACP) and remote [CMP-20, CMP-30].
8. **Open formats:** AGENTS.md, SKILL.md, MCP, ACP. Users can bring their setup with them [SKL-07, SKL-02, MCP-01, MCP-12].
9. **Hooks** for deterministic rules [FBK-10]; **LSP diagnostics** as feedback [CMP-20].
10. **Shareable artifacts:** threads [CMP-25], recipes [CMP-24], plugins [MCP-11].
11. **Inline rendering** that keeps the terminal's native feel [TRM-31].
12. **Public, reproducible benchmarking** [CMP-22, CMP-17].

---

## 5. Where we can differentiate

| Gap in the market | Our angle |
|---|---|
| Claude-Code-class UX and extension surface, but **open and multi-provider** | Same mental model and file formats (AGENTS.md, SKILL.md, hooks, MCP, plugins); BYO keys; per-model adaptation |
| **Safe autonomy** without prompt fatigue | Sandbox-first + AST permission engine + auto-reviewer, designed against the incident list above |
| **Transparent harness** | Visible context, versioned prompts with public evals and changelogs, pinning, and no silent defaults changes |
| **Honest cost** | Live cost and cache meter, budgets, provider routing/cascades (docs 02, 03) |
| **Reliable undo** | Shadow-git checkpoints covering bash, plus worktree-per-session |
| **Harness quality as a measured product** | Terminal-Bench/Harbor in CI; publish results [OTH-11, CMP-17] |

## 6. Watch list (re-check quarterly)
- Claude Code changelog and postmortems; Codex releases (sandbox, Windows); Gemini CLI releases.
- Terminal-Bench leaderboard shifts (harness x model) [CMP-17].
- New CVEs on coding agents (NVD search: claude-code, codex, gemini-cli, cursor).
- ACP adoption by editors; Agent Skills adoption.
- Pricing and quota changes across subscriptions.

<!-- SOURCES:CMP -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| CMP-01 | [A postmortem of three recent issues](https://www.anthropic.com/research/a-postmortem-of-three-recent-issues) | Anthropic | 2025-09-17 | Must read |
| CMP-02 | [An update on recent Claude Code quality reports (April 23 postmortem)](https://www.anthropic.com/research/april-23-postmortem) | Anthropic | 2026-04-23 | Must read |
| CMP-03 | [Recent Claude Code quality reports (commentary)](https://simonwillison.net/2026/Apr/24/recent-claude-code-quality-reports/) | Simon Willison | 2026-04-24 | Optional |
| CMP-04 | [Anthropic unveils new rate limits to curb Claude Code power users](https://techcrunch.com/2025/07/28/anthropic-unveils-new-rate-limits-to-curb-claude-code-power-users/) | TechCrunch | 2025-07-28 | Should read |
| CMP-05 | [Clarifying our pricing (June 2025 pricing)](https://cursor.com/blog/june-2025-pricing) | Cursor (Anysphere) | 2025-07-04 | Should read |
| CMP-06 | [Gemini CLI deleted user files after failed mkdir (AIID #1178)](https://incidentdatabase.ai/cite/1178/) | AI Incident Database | 2025-07-21 | Must read |
| CMP-07 | [Code execution through deception: Gemini CLI prompt injection](https://tracebit.com/blog/code-exec-deception-gemini-ai-cli-hijack) | Tracebit | 2025-07-28 | Must read |
| CMP-08 | [Vibe coding service Replit deleted production database](https://www.theregister.com/software/2025/07/21/vibe-coding-service-replit-deleted-production-database/719783) | The Register | 2025-07-21 | Must read |
| CMP-09 | [Destructive AI prompt published in Amazon Q extension](https://www.theregister.com/security/2025/07/24/destructive-ai-prompt-published-in-amazon-q-extension/615835) | The Register | 2025-07-24 | Should read |
| CMP-10 | [Weaponizing AI coding agents for malware in the Nx malicious package](https://snyk.io/blog/weaponizing-ai-coding-agents-for-malware-in-the-nx-malicious-package/) | Snyk | 2025-08-27 | Must read |
| CMP-11 | [Nx s1ngularity security advisory](https://github.com/nrwl/nx/security/advisories/GHSA-cxm3-wv7p-598c) | Nx (nrwl) | 2025-08-27 | Optional |
| CMP-12 | [CurXecute & MCPoison (CVE-2025-54135 / 54136) FAQ](https://www.tenable.com/blog/faq-cve-2025-54135-cve-2025-54136-vulnerabilities-in-cursor-curxecute-mcpoison) | Tenable | 2025-08 | Must read |
| CMP-13 | [CVE-2025-54795 (Claude Code command-parsing approval bypass)](https://nvd.nist.gov/vuln/detail/CVE-2025-54795) | NIST NVD | 2025-08 | Should read |
| CMP-14 | [CVE-2026-24887 (Claude Code find-command approval bypass)](https://nvd.nist.gov/vuln/detail/CVE-2026-24887) | NIST NVD | 2026-02 | Optional |
| CMP-15 | [Codex CLI is going native (Rust rewrite)](https://github.com/openai/codex/discussions/1174) | OpenAI | 2025-05-30 | Must read |
| CMP-16 | [Droid: the #1 software development agent on Terminal-Bench](https://factory.com/news/terminal-bench) | Factory | 2025-09-25 | Must read |
| CMP-17 | [Terminal-Bench leaderboard](https://www.tbench.ai/) | Terminal-Bench (Stanford / Laude) | 2026 | Should read |
| CMP-18 | [Measuring the impact of early-2025 AI on experienced open-source developer productivity](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/) | METR | 2025-07-10 | Should read |
| CMP-19 | [Stack Overflow Developer Survey 2025: AI](https://survey.stackoverflow.co/2025/ai) | Stack Overflow | 2025-07 | Should read |
| CMP-20 | [OpenCode](https://opencode.ai/docs) | Anomaly (formerly SST) | 2026 | Must read |
| CMP-21 | [Aider](https://github.com/Aider-AI/aider) | Aider (Paul Gauthier) | 2026 | Should read |
| CMP-22 | [Aider LLM leaderboards](https://aider.chat/docs/leaderboards/) | Aider | 2026 | Optional |
| CMP-23 | [Cline](https://github.com/cline/cline) | Cline | 2026 | Should read |
| CMP-24 | [goose](https://github.com/aaif-goose/goose) | Block -> AAIF (Linux Foundation) | 2026 | Should read |
| CMP-25 | [Amp](https://ampcode.com/docs) | Amp (Sourcegraph spin-out) | 2026 | Should read |
| CMP-26 | [GitHub Copilot CLI is now generally available](https://github.blog/changelog/2026-02-25-github-copilot-cli-is-now-generally-available/) | GitHub | 2026-02-25 | Optional |
| CMP-27 | [Kiro specs (spec-driven development)](https://kiro.dev/docs/specs/) | AWS | 2026 | Should read |
| CMP-28 | [Crush](https://github.com/charmbracelet/crush) | Charm | 2026 | Optional |
| CMP-29 | [Qwen Code](https://github.com/QwenLM/qwen-code) | Alibaba Qwen | 2026 | Optional |
| CMP-30 | [Claude Code via ACP in Zed](https://zed.dev/blog/claude-code-via-acp) | Zed Industries | 2025 | Should read |
| CMP-31 | [Introducing Gemini CLI](https://blog.google/innovation-and-ai/technology/developers-tools/introducing-gemini-cli-open-source-ai-agent/) | Google | 2025-06-25 | Optional |
| CMP-32 | [Codex CLI issue: approval prompts for nearly every command after upgrade](https://github.com/openai/codex/issues/9062) | GitHub (openai/codex) | 2026 | Optional |
<!-- /SOURCES -->
