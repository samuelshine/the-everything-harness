# 0015 — Skills, slash commands, output styles and skill routing

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/05-skills.md`, `docs/research/10-terminal-harness.md` §9, `docs/research/12-model-routing-and-local-models.md`, ADR-0010, ADR-0014; sources [SKL-01], [SKL-02], [SKL-04], [TRM-09], [TRM-10], [MCP-04]

## Context
People want reusable ways of working, invoked by name: `/human` to rewrite prose, `/research` to fan out a literature search, a "teach me" mode, a "plan first" habit. Claude Code covers this with four file-based mechanisms: skills, slash commands, output styles and subagents. Codex and others have adopted the same skill format [SKL-02, SKL-04]. ADR-0010 commits `teh` to Claude Code's file formats, so a user's existing skills should work unchanged.

Two things are different for `teh`:
- **Weak models miss skills.** Small local models often fail to notice that a skill applies, even when its description says so. Invoking a skill by name must therefore be deterministic, and automatic selection is a bonus.
- **Repos are untrusted.** A cloned repo can ship skills and commands. Their text enters the model's context, and their scripts could run.

## Options considered
1. **Own format.** Free to design, but it breaks existing skills and ADR-0010.
2. **Agent Skills spec plus Claude Code's command and output-style files, loaded by one loader** (chosen).
3. **Skills as MCP prompts only.** This needs a server per skill and loses progressive disclosure.

For choosing a skill automatically:
- **(a)** The main model sees the skill list and calls a `Skill` tool. This is Claude Code's approach.
- **(b)** An embedding pre-router shortlists skills by similarity to the prompt.
- **(c)** A small chat model (0.5–1.5B) picks the skill.
- **(d)** Combine them: (a) by default, with (b) and optionally (c) as a hint layer (chosen).

## Decision

**One loader, four kinds.** Every kind is a Markdown file with YAML frontmatter.

| Kind | Files | Loaded | Invoked by |
|---|---|---|---|
| Skill | `<dir>/<name>/SKILL.md` (+ files it references) | name and description at start; body on use | `/name`, or the model through the `Skill` tool |
| Command | `<dir>/commands/<name>.md` | on use | `/name` only; treated as a user-only skill |
| Output style | `<dir>/output-styles/<name>.md` | at start, for the whole session | `--output-style <name>` (later `/output-style`) |
| Agent | `<dir>/agents/<name>.md` | when delegated | the main model; specified by ADR-0007 |

**Where they are found.** User level first, then project level. On a name clash the user-level file wins, as in Claude Code, and a repo cannot shadow a user's skill.
- User: `~/.teh/`, then `~/.claude/` (compatibility).
- Project: `.teh/`, `.agents/` (skills only, per the spec), `.claude/`. Searched from the project root.
- Plugins later (ADR backlog).

**Frontmatter honoured.**
- `name`, `description` (required for skills; a command's description defaults to its first line).
- `argument-hint`.
- `disable-model-invocation` (the skill is listed for `/name` only).
- `user-invocable: false` (the model can use the skill, but `/name` does not list it).
- `model`: a role from ADR-0014, such as `fast`, `main` or `plan`. A stronger role than the current one asks first.
- `allowed-tools` is **parsed but not yet honoured as a grant**. In Claude Code it pre-approves tools while the skill is active. A repo skill must not be able to grant itself shell access, so this waits for ADR-0003. Until then a skill's actions go through the normal permission prompts.
- Unknown fields are kept and ignored. Invalid files are skipped with a warning in `teh skills`.

**Invoking by name.** A prompt starting with `/name args` runs that skill or command.
- The body is sent as the user message: `$ARGUMENTS` is replaced by `args`, and `$1`, `$2` and so on by individual arguments.
- If the body has no placeholder, the arguments are appended under "ARGUMENTS:".
- For a skill, the message also states the skill's directory, so the model can read the files the skill references.
- An unknown `/name` is an error that lists close matches. It is not sent to the model.

**Invoking by the model.** The system prompt lists the available skills by name and description, capped by a character budget (default 1% of the model's context window, at least 4,000 characters). A `Skill` tool returns a skill's body and directory. If the list exceeds the budget, skills are left out and the `Skill` tool can still load them by name. Every activation is logged as a session event for evals.

**Skill router (choosing automatically, opt-in).** A hint layer that runs before the main model, configured by `skillRouter`:
1. `off` (default until evals show it helps).
2. `embed`: embed every description once (cached by content hash) with a local embedding model, by default Ollama `nomic-embed-text`. Embed each prompt and shortlist the top 3 skills above a similarity threshold.
3. `embed+confirm`: also ask a small chat model, the `fast` role (e.g. a 0.5–1.5B model), to keep or drop each shortlisted skill. It sees only the shortlist and answers in a fixed JSON shape, so it cannot invent a skill.

The router never invokes a skill. It adds one line to the system prompt for that turn ("These skills look relevant: …"), and the main model decides. Explicit `/name` always bypasses it.

Why not a small chat model alone: picking one of dozens of options is classification. Embeddings do it faster and more consistently, and very small chat models tend to invent names or break the output format. The small model is used only where it adds judgement: confirming a short list.

**Output styles.** An output style replaces the response-format part of the base system prompt. Selected with `--output-style` or the `outputStyle` setting (project over user); a resumed session keeps its style.
- **Coding guidance:** dropped unless the style sets `keep-coding-instructions: true`. *Amended 2026-11-04 when built:* this follows Claude Code's default, so styles written for it behave the same. The draft above had the opposite default.
- **Safety guidance always stays:** don't retry denied actions unchanged, and don't invent results.
- **Built-in styles:** `default`, `explanatory` (adds "Insight" notes about why the code is shaped as it is) and `learning` (the user writes small key pieces at `TODO(human)` markers). The names match Claude Code's; the text is teh's own.
- **Precedence:** a user file can replace a built-in style, but a project file can replace neither a built-in nor a user style.

**Thinking patterns.** Effort and reasoning settings belong to the model policy (ADR-0014): roles carry an effort level. A skill or style can ask for a role, never for a raw model id.

**Trust.**
- Project-level skills, commands and styles are untrusted text. They are loaded, but the first time a project's set changes, `teh skills` and the TUI show what is new.
- Scripts they mention run only through the normal tools and permission engine.

## Consequences
- Users' existing Claude Code skills, commands and styles work in `teh` with any model.
- Evals can now ask whether the model picked the right skill, comparing the router modes (`off`, `embed`, `embed+confirm`) across models. This is a research question for the paper.
- The `embed` router adds a dependency on a local embedding model. If none is available, the router turns itself off with a one-line warning.
- `allowed-tools` grants and agent definitions are deferred, to ADR-0003 and ADR-0007.
- **Revisit** if the Agent Skills spec adds trust or signing fields, or if evals show the router hurts strong models.
