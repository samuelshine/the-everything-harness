import { homedir } from "node:os";
import { join } from "node:path";
import { ChatGPTCredentials } from "../auth/chatgpt";
import { ProviderError } from "../types";
import { AnthropicProvider } from "./anthropic";
import { COMPATIBLE_PRESETS, type CompatibleConfig, CompatibleProvider } from "./compatible";
import { DEFAULT_NUM_CTX, OllamaProvider } from "./ollama";
import { OpenAIProvider } from "./openai";
import type { Provider } from "./provider";
import type { Capabilities } from "./registry";

export type ModelRef = { provider: string; model: string };

// "ollama:qwen2.5:14b" -> { provider: "ollama", model: "qwen2.5:14b" }. Only the first colon splits.
export function parseModelRef(ref: string): ModelRef {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) {
    throw new ProviderError(
      "bad_request",
      `model "${ref}" must look like <provider>:<model>, e.g. ollama:qwen2.5:14b or anthropic:claude-sonnet-5-5`,
    );
  }
  return { provider: ref.slice(0, i), model: ref.slice(i + 1) };
}

export type ProviderSettings = {
  // "providers" from the user's settings: extra OpenAI-compatible servers, or changes to presets.
  providers?: Record<string, CompatibleConfig>;
  // "modelOverrides": capability corrections, keyed "<provider>:<model>".
  overrides?: Record<string, Capabilities>;
  tehHome?: string;
};

export const BUILTIN_PROVIDERS = ["ollama", "anthropic", "openai", "chatgpt", ...Object.keys(COMPATIBLE_PRESETS)];

export function createProvider(
  name: string,
  env: Record<string, string | undefined> = process.env,
  settings: ProviderSettings = {},
): Provider {
  const overrides = settings.overrides ?? {};
  const custom = settings.providers?.[name];
  if (custom || (COMPATIBLE_PRESETS[name] && name !== "openai")) {
    const config = { ...COMPATIBLE_PRESETS[name], ...custom } as CompatibleConfig;
    if (!config.baseUrl)
      throw new ProviderError("bad_request", `provider "${name}" has no baseUrl`, `add "baseUrl" under "providers"`);
    return new CompatibleProvider(name, config, env, { overrides });
  }
  switch (name) {
    case "ollama": {
      const numCtx = Number(env.TEH_OLLAMA_NUM_CTX) || DEFAULT_NUM_CTX;
      return new OllamaProvider({ numCtx });
    }
    case "anthropic":
      return new AnthropicProvider({
        ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
        ...(env.ANTHROPIC_BASE_URL ? { baseUrl: env.ANTHROPIC_BASE_URL } : {}),
        overrides,
      });
    case "openai":
      return new OpenAIProvider({
        id: "openai",
        ...(env.OPENAI_API_KEY ? { apiKey: env.OPENAI_API_KEY } : {}),
        ...(env.OPENAI_BASE_URL ? { baseUrl: env.OPENAI_BASE_URL } : {}),
        overrides,
      });
    case "chatgpt": {
      const creds = new ChatGPTCredentials(settings.tehHome ?? join(homedir(), ".teh"));
      if (!creds.signedIn())
        throw new ProviderError("auth", "not signed in to ChatGPT", "run `teh login chatgpt` (Continue with ChatGPT)");
      return new OpenAIProvider({ id: "chatgpt", token: () => creds.accessToken(), overrides });
    }
    default:
      throw new ProviderError(
        "bad_request",
        `unknown provider "${name}"`,
        `built in: ${BUILTIN_PROVIDERS.join(", ")}; add other OpenAI-compatible servers under "providers" in ~/.teh/settings.json`,
      );
  }
}

// Cloud providers the user has credentials for, so teh can list or default to them.
export function configuredCloudProviders(
  env: Record<string, string | undefined>,
  settings: ProviderSettings = {},
): string[] {
  const out: string[] = [];
  if (env.ANTHROPIC_API_KEY) out.push("anthropic");
  if (env.OPENAI_API_KEY) out.push("openai");
  if (new ChatGPTCredentials(settings.tehHome ?? join(homedir(), ".teh")).signedIn()) out.push("chatgpt");
  return out;
}
