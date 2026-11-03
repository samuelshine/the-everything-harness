# Harness research

Research for **the-everything-harness**: what the major AI labs, research groups and practitioners have published about building agent harnesses. It covers context, providers, performance, prompts, skills, plugins/MCP, feedback, delegation, the cross-cutting topics (security, evals, observability, UX), the terminal harness itself, and the competitive landscape.

The harness is **terminal-first**: it should be usable the way Claude Code is. See [10](10-terminal-harness.md) and [11](11-competitive-landscape.md).

- **Start here:** [00 — Synthesis](00-synthesis.md): principles, reference architecture, build order, open decisions.
- **Source list:** [`sources.csv`](sources.csv), mirrored to the Google Sheet "Harness" (one tab per topic, plus "All sources").

## Contents
| # | Topic | File |
|---|-------|------|
| 00 | Synthesis & architecture | [00-synthesis.md](00-synthesis.md) |
| 01 | Context optimisation, storage & persistence | [01-context-storage-persistence.md](01-context-storage-persistence.md) |
| 02 | Multi-LLM provider connector | [02-multi-llm-providers.md](02-multi-llm-providers.md) |
| 03 | Optimisation: speed & cost | [03-performance.md](03-performance.md) |
| 04 | Prompt optimisation | [04-prompt-optimisation.md](04-prompt-optimisation.md) |
| 05 | Skill connector (model-agnostic) | [05-skills.md](05-skills.md) |
| 06 | Plugins, MCP & protocols | [06-plugins-mcp.md](06-plugins-mcp.md) |
| 07 | Feedback & guidance | [07-feedback-guidance.md](07-feedback-guidance.md) |
| 08 | Agent creation & delegation | [08-agents-delegation.md](08-agents-delegation.md) |
| 09 | Other: security, evals, observability, UX, ops, harness basics | [09-other-topics.md](09-other-topics.md) |
| 10 | Terminal harness: Claude-Code-class CLI/TUI requirements | [10-terminal-harness.md](10-terminal-harness.md) |
| 11 | Competitive landscape: wins, flaws, incidents, positioning | [11-competitive-landscape.md](11-competitive-landscape.md) |
| 12 | Model routing (task → model) and local models (Ollama, LM Studio, llama.cpp); instruction files across providers | [12-model-routing-and-local-models.md](12-model-routing-and-local-models.md) |

## Method
- **Scope**: primary sources first: engineering blogs, docs and specs from Anthropic, OpenAI, Google/DeepMind, Microsoft, plus the Linux Foundation, OWASP and OpenTelemetry. Then peer-reviewed or arXiv papers, then practitioner write-ups (Manus, Cognition, LangChain, Chroma, Simon Willison, Martin Fowler).
- **Verification column** in `sources.csv`:
  - `arXiv metadata checked`: ID, title and date confirmed against the arXiv API.
  - `URL live; page read`: URL returned HTTP 200, and the page itself was fetched and read.
  - `URL live; summary from search`: URL returned HTTP 200, and the takeaway comes from search results or the page.
  - `URL live; content not read`: link confirmed, contents not summarised (e.g. dynamic leaderboards).
  - `From your sheet (read in full)`: links already in the sheet, fetched and read.
  - `Summary from search (site blocks bots)`: openai.com pages that return 403 to automated fetches. The URL comes from search results.
- **Competitor claims** (doc 11): failures are cited to postmortems, CVEs, incident reports or the vendor's own issue tracker, not to opinion. Where a judgement is ours, it is labelled.
- **Figures quoted** (e.g. "+39%", "84% fewer prompts") are the publishers' own reported numbers, usually internal evals. Treat them as directional.
- **Date of research:** 2026-11-02. Protocol specs (MCP, Agent Skills, OTel GenAI) are changing quickly, so re-check them quarterly.

## Source ID prefixes
`BAS` harness basics · `CTX` context/memory · `LLM` providers · `PERF` performance · `PRM` prompts · `SKL` skills · `MCP` plugins/protocols · `FBK` feedback/guidance · `AGT` agents/delegation · `OTH` security/evals/observability/UX · `TRM` terminal harness (CLI/TUI) · `CMP` competitive landscape · `RTE` routing and local models.
