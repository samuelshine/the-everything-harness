# Product brief

Decisions about what we are building and for whom. Technical decisions live in [`adr/`](adr/README.md).

| | Decision | Date |
|---|---|---|
| **Name** | The Everything Harness | 2026-11-03 |
| **Command** | `teh`. User config in `~/.teh/`, project config in `.teh/`. The bare `harness` name was rejected because it clashes with the Harness.io CLI. | 2026-11-03 |
| **Audience** | Individual developers first, starting with the maintainer. Collaboration features (shared sessions, team settings, review flows) come later, so the design must not assume one user per session forever. | 2026-11-03 |
| **Business model** | Free and open source (Apache-2.0) now. A hosted version may come later; it would need partner approval from Anthropic and OpenAI for subscription logins ([ADR-0009](adr/0009-provider-auth-and-subscriptions.md)). | 2026-11-03 |
| **Default safety** | Ask before every action that changes something ([ADR-0008](adr/0008-default-approval-posture.md)). | 2026-11-03 |
| **Claude Code compatibility** | Mirror Claude Code's flags, commands and project files closely, so a Claude Code user can switch without relearning ([ADR-0010](adr/0010-claude-code-compatibility.md)). | 2026-11-03 |
| **Telemetry** | Anonymous usage statistics, on by default, with a first-run notice and a one-step opt-out ([ADR-0011](adr/0011-telemetry.md)). | 2026-11-03 |
| **Model routing** | A model policy picks the model per task (cheap for simple work, strong for hard work) to cut tokens and cost. Users can always pin a model ([research 12](research/12-model-routing-and-local-models.md), ADR-0014). | 2026-11-03 |
| **Local models** | Any locally deployed model works: Ollama, LM Studio, llama.cpp, vLLM, or any OpenAI-compatible endpoint, plus a local-only mode with no other network traffic. | 2026-11-03 |
| **Subscriptions** | Supported: ChatGPT plans directly, Claude plans through the user's own Claude Code ([ADR-0009](adr/0009-provider-auth-and-subscriptions.md)). | 2026-11-03 |

## What this implies for the design
- **Terminal first, usable like Claude Code**, and the engine stays separate from the terminal UI ([ADR-0001](adr/0001-language-runtime-and-distribution.md)), so a hosted or collaborative client can be added later without a rewrite.
- **Sessions, settings and permissions carry an owner** even though there is only one user today. That keeps the later move to shared sessions additive.
- **Nothing in the open-source CLI depends on a hosted service.** Telemetry failures, or a missing endpoint, never block or slow the tool.
