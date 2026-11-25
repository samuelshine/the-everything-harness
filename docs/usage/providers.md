# Models and providers

Pick a model with `--model <provider>:<model>`, `TEH_MODEL`, or `"model"` in settings. `teh models` lists what each configured provider offers, with list prices for paid ones.

| Provider | Use as | Needs | Paid by |
|---|---|---|---|
| Ollama | `ollama:gemma4:e4b` | Ollama running (`OLLAMA_HOST` to point elsewhere) | nothing (local) |
| Anthropic | `anthropic:claude-sonnet-5-5` | `ANTHROPIC_API_KEY` | API key, at list prices |
| OpenAI | `openai:gpt-6.1-sol` | `OPENAI_API_KEY` | API key, at list prices |
| ChatGPT plan | `chatgpt:gpt-6.1-sol` | `teh login chatgpt` | your ChatGPT plan |
| LM Studio, llama.cpp, vLLM | `lmstudio:<model>`, `llamacpp:<model>`, `vllm:<model>` | the server on its default port | nothing (local) |
| OpenRouter, Groq | `openrouter:<model>`, `groq:<model>` | `OPENROUTER_API_KEY`, `GROQ_API_KEY` | the service |

**No model given:** `teh` picks one of your installed Ollama models for the task (ADR-0014). If none can call tools and `ANTHROPIC_API_KEY` is set, it uses `anthropic:claude-opus-5-5`, and explore subagents use `anthropic:claude-haiku-5-5`.

**Claude subscriptions** (Pro, Max) are not used by `teh`'s own loop. Anthropic allows them only in Claude Code itself (ADR-0009).

## ChatGPT plan
`teh login chatgpt` opens your browser at **Continue with ChatGPT**. After you approve, eligible usage in `teh` uses your ChatGPT plan; manage it at [chatgpt.com/settings/usage](https://chatgpt.com/settings/usage).
- The sign-in is stored in the macOS keychain or the Linux Secret Service (`secret-tool`), or in `~/.teh/auth/secrets/` readable only by you where neither exists (`TEH_SECRET_STORE=file` forces that).
- `teh logout chatgpt` revokes it.
- The status line says **Using ChatGPT plan** while it is in use. When the plan's limit is reached, `teh` stops and links to the usage page; it never switches to an API key on its own.

## Other OpenAI-compatible servers
Add them to `~/.teh/settings.json`. Only your own settings can do this, so a cloned repository cannot send your requests, or your keys, somewhere else.
```json
{
  "providers": {
    "mybox": { "baseUrl": "http://10.0.0.2:8000/v1", "apiKeyEnv": "MYBOX_KEY", "contextWindow": 65536 }
  }
}
```
- `contextWindow`: the window to assume when the server does not report one (default 32,768).
- `streamUsage: false`: for servers that reject `stream_options`.
- `vision: true`: the model accepts images.
- `paid: true`: count it as paid in the usage panel.

The same block can change a preset, for example `"lmstudio": {"baseUrl": "http://127.0.0.1:5000/v1"}`.

## Capabilities and prices
Context sizes, vision, reasoning and prices come from a [models.dev](https://models.dev) snapshot bundled with `teh` (`bun packages/core/scripts/update-model-registry.ts` refreshes it). Correct an entry in your settings:
```json
{ "modelOverrides": { "anthropic:claude-sonnet-5-5": { "context": 200000 } } }
```
The **Usage** tab of `/usage` shows the session's cost at list prices. `--output-format json` adds `total_cost_usd` and `auth_route` to the result.
