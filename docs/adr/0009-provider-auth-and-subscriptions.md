# 0009 — Provider authentication and subscription access

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/02-multi-llm-providers.md` (Authentication and subscriptions), `docs/research/10-terminal-harness.md` §11, sources [LLM-11]–[LLM-21], [TRM-06], [MCP-12], [CMP-30]

## Context
Many developers already pay for a Claude (Pro/Max) or ChatGPT (Plus/Pro) subscription and want any coding agent they use to draw on it rather than a separate pay-per-token API key. Whether a third-party harness may do that is set by each provider's terms, and the two providers differ sharply (checked 2026-11-03):

- **Anthropic** reserves subscription OAuth for Claude Code and its own apps. Third-party developers may not offer Claude.ai login, route requests through Free/Pro/Max/Ultra credentials on users' behalf, or collect, store or intermediate Claude.ai tokens. This applies to products built on the Agent SDK too [LLM-11, LLM-12]. Anthropic has enforced it since January 2026, including account bans [LLM-13]. The same terms explicitly allow an end user to sign in to the **unmodified** Claude Code binary with their own subscription, including when another product runs that binary [LLM-11].
- **OpenAI** offers "Sign in with ChatGPT". Commercial apps need partner approval, but **ChatGPT plan usage is available to all open-source, locally hosted apps** through dynamic client registration with PKCE and no client secret [LLM-14, LLM-15, LLM-16]. The plan route is a restricted Responses API profile: `store:false`, `stream:true`, full history in `input`, no sampling parameters, no hosted tools [LLM-17]. Codex app-server can run on the same token [LLM-18]. Reusing Codex's own login (`~/.codex/auth.json`) is not that route [LLM-19].

So "use my subscription" means three different things technically: a model provider inside our loop, a whole external agent we delegate to, or a borrowed login. Only the first two are legitimate, and only in some combinations.

## Options considered
1. **API keys only.** Simple and unambiguous. Excludes the large group of users who only have subscriptions, which most competitors serve.
2. **Reuse first-party logins** (read `~/.claude` / `~/.codex` credentials, or copy a client ID). Works until it doesn't. It violates Anthropic's terms and risks bans for our users [LLM-11, LLM-13], and it is undocumented and fragile for OpenAI.
3. **Tiered: legitimate routes only** (chosen):
   - **Model providers** (our loop, our tools, our sandbox): API keys and cloud credentials for every provider, plus **Sign in with ChatGPT plan usage** on the OpenAI adapter, provided the project qualifies as open source and locally hosted.
   - **External agent backends** (delegation): run the user's own installed, unmodified `claude` (headless `-p --output-format stream-json` [TRM-06] or ACP [MCP-12, CMP-30]) or `codex` (app-server [LLM-20] or `codex exec`). Each signs in with its own first-party flow and spends the user's subscription. We never see its credentials.
4. **Become an approved partner** with each provider. A later option for a hosted or paid product. Not needed for a local open-source CLI.

## Decision
Option 3.

1. **Our loop never uses Claude subscription credentials.** Anthropic in our loop means an API key or a cloud provider (Bedrock, Vertex, Foundry).
2. **ChatGPT plan usage is a first-class auth method on the OpenAI Responses adapter**, implemented exactly as OpenAI documents it for open-source apps:
   - our own dynamic client registration with a stable per-host `ext_agent_host_id`;
   - a "Continue with ChatGPT" button;
   - tokens kept in the OS keychain, never logged;
   - a `chatgpt-plan` request profile that strips unsupported fields and always sends full history.
3. **Claude Code and Codex are delegation backends, not providers.** Both are adapters behind the subagent interface: a task goes in, and a stream of events plus a final result comes out. We require the binaries to be installed by the user, we run them unmodified, and we never pass, read or proxy their credentials.
4. **Never impersonate a first-party client.** We do not read `~/.claude/` or `~/.codex/auth.json` and do not copy client IDs, user agents or system prompts. CI includes a test that fails if engine code references those paths.
5. **The interface is honest about who is doing the work.** The status line names the auth route ("API key", "ChatGPT plan", "via Claude Code"). A delegated run is labelled as such, because its tools, permissions and sandbox are the backend's, not ours.

## Consequences
- **Prerequisite:** ChatGPT plan usage depends on the project being open source and locally hosted [LLM-15]. Met on 2026-11-03: the repository is public and licensed Apache-2.0. If we ever ship a paid or hosted version, it needs OpenAI's interest form [LLM-15].
- **Delegated runs sit outside our safety model.** Checkpoints still work, because shadow-git snapshots the workspace before and after the run. Our permission rules, sandbox and per-tool events do not apply inside the run. Mitigations:
  - run the backend in our OS sandbox where it allows;
  - map its approval requests (Codex app-server sends them as server requests [LLM-20]; ACP has permission requests) into our approval UI;
  - default delegated runs to the backend's most restrictive mode.
- **Adapter work:** a SIWC login flow and token refresh (serialised refreshes, because tokens rotate), a `chatgpt-plan` request profile with its own contract tests, and two backend adapters (Claude Code headless/ACP and Codex app-server). Each is pinned to a tested CLI version, because both protocols are still evolving.
- **Branding:** we may say a feature "runs Claude Code" in plain text. We must not use Claude Code or Anthropic names or logos in our product name or UI chrome [LLM-11, LLM-12]. Sign-in uses OpenAI's approved "Continue with ChatGPT" button [LLM-16].
- **Revisit when:** Anthropic offers a sanctioned third-party subscription route; OpenAI changes plan-usage eligibility or limits; we ship a hosted or paid version (that needs partner approval from both); or provider enforcement changes. Re-check the provider terms quarterly with the competitive watch list.
- **Open question for implementation:** whether running the user's `claude` binary from our harness requires anything beyond the conditions quoted in [LLM-11] ("unmodified binary", "own credentials"). Confirm with Anthropic before a public release.
