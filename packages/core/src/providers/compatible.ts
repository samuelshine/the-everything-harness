// Generic Chat Completions adapter (ADR-0002) for OpenAI-compatible servers: LM Studio, llama.cpp,
// vLLM, OpenRouter, Groq, a LiteLLM proxy or any gateway. It assumes only the base spec:
// streamed deltas, function tools, and usage when the server reports it.
import OpenAI from "openai";
import type {
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { type Item, type ModelRequest, ProviderError, type StopReason, type StreamEvent } from "../types";
import { mapHttpError } from "./errors";
import type { ModelInfo, ProbeResult, Provider } from "./provider";
import type { AuthRoute, Capabilities } from "./registry";

export type CompatibleConfig = {
  baseUrl: string;
  // Name of the environment variable holding the key, if the server needs one.
  apiKeyEnv?: string;
  // The window to assume when the server does not say. Local servers often run small ones.
  contextWindow?: number;
  // Whether the server is paid per token (OpenRouter, Groq) or runs locally.
  paid?: boolean;
  // Some servers reject stream_options; set false for those.
  streamUsage?: boolean;
  vision?: boolean;
};

// Built-in presets; the user's "providers" setting adds more or overrides these.
export const COMPATIBLE_PRESETS: Record<string, CompatibleConfig> = {
  lmstudio: { baseUrl: "http://127.0.0.1:1234/v1" },
  llamacpp: { baseUrl: "http://127.0.0.1:8080/v1" },
  vllm: { baseUrl: "http://127.0.0.1:8000/v1" },
  openrouter: { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY", paid: true },
  groq: { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY", paid: true },
};

const DEFAULT_WINDOW = 32_768;

export class CompatibleProvider implements Provider {
  readonly route: AuthRoute;
  private readonly client: OpenAI;

  constructor(
    readonly id: string,
    private readonly config: CompatibleConfig,
    env: Record<string, string | undefined> = process.env,
    opts: { fetch?: typeof fetch; overrides?: Record<string, Capabilities> } = {},
  ) {
    this.route = config.paid ? "api-key" : "local";
    const key = config.apiKeyEnv ? env[config.apiKeyEnv] : undefined;
    if (config.apiKeyEnv && !key) throw new ProviderError("auth", `${id} needs an API key`, `set ${config.apiKeyEnv}`);
    this.client = new OpenAI({
      apiKey: key ?? "not-needed",
      baseURL: config.baseUrl.replace(/\/+$/, ""),
      maxRetries: config.paid ? 2 : 0,
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list()) {
        const window =
          (m as { context_length?: number; max_model_len?: number }).context_length ??
          (m as { max_model_len?: number }).max_model_len;
        // The spec has no way to say whether a model takes tools, so this stays unknown.
        out.push({ id: m.id, ...(window ? { contextWindow: window } : {}) });
      }
      return out;
    } catch (e) {
      throw mapError(this.id, this.config.baseUrl, e);
    }
  }

  async probe(model: string): Promise<ProbeResult> {
    const notes: string[] = [];
    let contextWindow = this.config.contextWindow;
    if (!contextWindow) {
      const listed = await this.listModels().catch(() => []);
      contextWindow = listed.find((m) => m.id === model)?.contextWindow;
    }
    if (!contextWindow) {
      notes.push(
        `${this.id} does not report ${model}'s context window; assuming ${DEFAULT_WINDOW} tokens (set "contextWindow" for "${this.id}" under "providers" in ~/.teh/settings.json)`,
      );
      contextWindow = DEFAULT_WINDOW;
    }
    return { supportsTools: true, contextWindow, vision: this.config.vision ?? false, notes };
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const params: ChatCompletionCreateParamsStreaming = {
      model: req.model,
      messages: toChatMessages(req.system, req.items),
      stream: true,
      ...(this.config.streamUsage !== false ? { stream_options: { include_usage: true } } : {}),
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              function: { name: t.name, description: t.description, parameters: t.inputSchema },
            })),
          }
        : {}),
      ...(req.maxOutputTokens ? { max_tokens: req.maxOutputTokens } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.json ? { response_format: { type: "json_object" } } : {}),
    };
    let stream: AsyncIterable<ChatCompletionChunk>;
    try {
      stream = await this.client.chat.completions.create(params, signal ? { signal } : {});
    } catch (e) {
      throw mapError(this.id, this.config.baseUrl, e);
    }

    // Tool calls arrive in pieces keyed by index.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null = null;
    let calls = 0;
    try {
      for await (const chunk of stream) {
        if (chunk.usage) {
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens ?? 0;
          yield {
            type: "usage",
            usage: {
              input: chunk.usage.prompt_tokens - cached,
              cachedRead: cached,
              cacheWrite: 0,
              output: chunk.usage.completion_tokens,
            },
          };
        }
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta as typeof choice.delta & { reasoning_content?: string; reasoning?: string };
        const thinking = delta.reasoning_content ?? delta.reasoning;
        if (thinking) yield { type: "reasoning_delta", text: thinking };
        if (delta.content) yield { type: "text_delta", text: delta.content };
        for (const tc of delta.tool_calls ?? []) {
          const p = pending.get(tc.index) ?? { id: "", name: "", args: "" };
          if (tc.id) p.id = tc.id;
          if (tc.function?.name) p.name += tc.function.name;
          if (tc.function?.arguments) p.args += tc.function.arguments;
          pending.set(tc.index, p);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (e) {
      throw mapError(this.id, this.config.baseUrl, e);
    }
    for (const [i, p] of [...pending.entries()].sort(([a], [b]) => a - b)) {
      calls++;
      yield { type: "tool_call", id: p.id || `${this.id}_call_${i + 1}`, name: p.name, args: parseArgs(p.args) };
    }
    const reason: StopReason =
      calls > 0 ? "tool_use" : finish === "length" ? "max_tokens" : finish === "content_filter" ? "refusal" : "end";
    yield { type: "stop", reason };
  }
}

function parseArgs(json: string): unknown {
  if (!json.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { _unparsed: json };
  }
}

export function toChatMessages(system: string, items: Item[]): ChatCompletionMessageParam[] {
  const out: ChatCompletionMessageParam[] = [{ role: "system", content: system }];
  let assistant: Extract<ChatCompletionMessageParam, { role: "assistant" }> | undefined;
  const images: ChatCompletionContentPart[] = [];
  const flushImages = () => {
    if (!images.length) return;
    out.push({
      role: "user",
      content: [{ type: "text", text: "(The images from the tool results above.)" }, ...images],
    });
    images.length = 0;
  };
  for (const item of items) {
    if (item.kind === "reasoning") continue;
    if (item.kind === "tool_call" || (item.kind === "text" && item.role === "assistant")) {
      if (!assistant) {
        assistant = { role: "assistant", content: "" };
        out.push(assistant);
      }
      if (item.kind === "text") assistant.content = `${assistant.content ?? ""}${item.text}`;
      else
        assistant.tool_calls = [
          ...(assistant.tool_calls ?? []),
          { id: item.id, type: "function", function: { name: item.name, arguments: JSON.stringify(item.args ?? {}) } },
        ];
      continue;
    }
    assistant = undefined;
    if (item.kind === "text") {
      flushImages();
      out.push({ role: "user", content: item.text });
    } else {
      out.push({ role: "tool", tool_call_id: item.callId, content: item.content || "(no output)" });
      // Chat Completions has no images in tool messages, so they follow as a user message.
      for (const i of item.images ?? [])
        images.push({ type: "image_url", image_url: { url: `data:${i.mediaType};base64,${i.data}` } });
    }
  }
  flushImages();
  return out;
}

function mapError(id: string, baseUrl: string, e: unknown): unknown {
  if (e instanceof ProviderError || (e as Error)?.name === "AbortError") return e;
  if (e instanceof OpenAI.APIUserAbortError) {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  }
  if (e instanceof OpenAI.APIConnectionError)
    return new ProviderError("unavailable", `cannot reach ${id} at ${baseUrl}`, "is the server running?");
  if (e instanceof OpenAI.APIError) return mapHttpError(id, e.status, e.message);
  return e;
}
