# 0021 — Web, to-do and notebook tools

- **Status:** Proposed
- **Date:** 2026-11-11
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` (tool set), `docs/research/07-feedback-guidance.md`, ADR-0003, ADR-0008, ADR-0010, ADR-0019, ADR-0020

## Context
teh had Claude Code's file and shell tools (Read, Write, Edit, Glob, Grep, Bash) plus Skill and Task. Three gaps remained in the built-in set Claude Code users expect (ADR-0010):
- **No task list.** Small models lose track of multi-step requests. In a live run, gemma4:e4b wrote a four-item list, never updated it and stopped with a file unwritten.
- **No web access.** The model could not read documentation, changelogs or issues the user points to.
- **No notebook editing.** Editing `.ipynb` JSON with Edit breaks notebooks.

Reaching the network is a new kind of risk: a request can carry project data to another machine, and fetched pages can carry instructions aimed at the model.

## Decision
- **TodoWrite.** The model passes the whole list each time: `content`, `status` (`pending`, `in_progress`, `completed`), optional `activeForm`. It needs no approval and changes nothing on disk; the list lives in the conversation as the call's arguments.
  - **Shown:** as a checklist under the call. The in-progress item's `activeForm` replaces "Working…" on the spinner. `/todos` shows the list again.
  - **Kept:** compaction (ADR-0020) adds the latest list to the summary, and carries it forward from one summary to the next.
  - **Enforced:** if the model ends its turn while the list it wrote for this prompt has open items, teh adds a note listing them and asks it to continue or update the list. At most twice per prompt. A list from an earlier prompt is not enforced.
- **WebFetch** takes `url` and `prompt`.
  - **Fetching:** plain http is upgraded to https, except for local servers. Same-host redirects are followed (www. is ignored); a redirect to another host is reported, so that host gets its own permission check. Pages are capped at 10 MB and cached for 15 minutes.
  - **Reading:** HTML becomes Markdown with a small converter of our own (no dependency). It keeps headings, links (made absolute), lists, code blocks and tables, and drops scripts, styles, navigation, footers and forms; `<main>` or `<article>` is used when present. JSON and text pass through; other types are refused.
  - **Helper model:** a page longer than 2,000 characters is read by a helper with the caller's prompt. The helper is the explore model (ADR-0019) when there is one, else the main model. Its tokens count in usage but not in the conversation. If it fails, up to 20,000 characters of Markdown come back instead.
  - **Untrusted:** every result starts with the URL, the page title and a line saying the content is untrusted data. The helper is told not to follow instructions in the page.
- **WebSearch** takes `query`, `allowed_domains` and `blocked_domains`, and returns up to 10 results (title, URL, snippet), marked untrusted.
  - **Engines:** DuckDuckGo's HTML page by default (free, no key), a SearXNG instance (`url`), or Brave (`BRAVE_SEARCH_API_KEY` from the environment).
  - **Engine choice is user settings only**, so a cloned repository cannot send your searches to its own server.
- **Network permission.** A new access kind, `network`, names the host. It asks in every mode except `bypassPermissions`, plan mode included: nothing local changes, but data can leave.
  - **Rules use Claude Code's syntax:** `WebFetch(domain:docs.rs)` for one host, `WebFetch(domain:*.rust-lang.org)` for a domain and its subdomains, `WebFetch` or `WebSearch` for all.
  - **Approvals:** the approval prompt offers the domain rule. Headless runs refuse unless a rule allows.
  - **Privacy:** requests carry a generic user agent and nothing about the user or the project.
- **NotebookEdit** follows Claude Code's arguments: `notebook_path`, `cell_id`, `new_source`, `cell_type`, `edit_mode` (`replace`, `insert`, `delete`).
  - **Reading first:** Read shows a notebook as `<cell id type>` blocks with text outputs (images named, outputs clipped), and NotebookEdit requires a fresh Read, like Edit.
  - **Cell ids:** cells without ids (nbformat before 4.5) are addressed as `cell-N` or by position.
  - **Edits:** replacing a code cell clears its outputs and execution count. The file is written in Jupyter's layout.
- **`--allowedTools` takes several rules** after one flag, as in Claude Code. Before this it took one, and the rest became prompt text. Arguments are read as rules while they name a known tool or an MCP tool.

## Consequences
- **Good:** the model can read documentation directly. Live check: gemma4:e4b searched, fetched two Bun docs pages, and named both flags and the URL correctly in 45 s, with the main context under 4k tokens.
- **Good:** to-do lists give small models a structure that the harness can check, without depending on the model's honesty.
- **Cost:** four more tool definitions in every request: about 3.2k characters (~800 tokens by the 4-characters estimate), roughly doubling the built-in tool definitions.
- **Risk:** prompt injection through fetched pages. It is reduced (untrusted marking, helper reading, per-domain approval) but not removed: an approved fetch still returns text the model reads.
- **Risk:** DuckDuckGo can rate-limit or ask for a captcha. The error says so and points to SearXNG or Brave.
- **Found on the way:** the `--allowedTools` bug affected the model-routing eval (ADR-0014): only its first Bash rule applied. Its README says so; it should be rerun.
- **Not decided here:** background shells (`run_in_background`, BashOutput, KillShell), ExitPlanMode, PDF and image reading.
