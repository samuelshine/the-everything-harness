import { ProviderError } from "../types";
import { DEFAULT_NUM_CTX, OllamaProvider } from "./ollama";
import type { Provider } from "./provider";

export type ModelRef = { provider: string; model: string };

// "ollama:qwen2.5:14b" -> { provider: "ollama", model: "qwen2.5:14b" }. Only the first colon splits.
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) {
    throw new ProviderError("bad_request", `model "${ref}" must look like <provider>:<model>, e.g. ollama:qwen2.5:14b`);
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export function createProvider(name: string, env: Record<string, string | undefined> = process.env): Provider {
  switch (name) {
    case "ollama": {
      const numCtx = Number(env.TEH_OLLAMA_NUM_CTX) || DEFAULT_NUM_CTX;
      return new OllamaProvider({ numCtx });
    }
    default:
      throw new ProviderError(
        "bad_request",
        `unknown provider "${name}"`,
        "available now: ollama (anthropic, openai and openai-compatible are next)",
      );
  }
}
