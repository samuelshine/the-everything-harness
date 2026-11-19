// OpenAI Responses API adapter (ADR-0002), over the official SDK. Two auth routes (ADR-0009):
// - "openai": an API key, priced from the registry;
// - "chatgpt": the user's ChatGPT plan through Sign in with ChatGPT. That profile always sends
//   store:false and stream:true with the full history, puts the system prompt in `instructions`,
//   and leaves out the fields the plan route rejects (temperature, max_output_tokens, …) [LLM-17].
// Both routes send store:false and replay reasoning as encrypted items, so no conversation state
// is kept on OpenAI's side.
import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseFunctionCallOutputItemList,
  ResponseInputItem,
  ResponseStreamEvent,
} from "openai/resources/responses/responses";
import { type Item, type ModelRequest, ProviderError, type StopReason, type StreamEvent } from "../types";
import { mapHttpError } from "./errors";
import type { ModelInfo, ProbeResult, Provider } from "./provider";
import { type Capabilities, capabilities } from "./registry";

export const OPENAI_BASE_URL = "https://api.openai.com/v1";

export type OpenAIOptions = {
  // "openai" for an API key, "chatgpt" for the ChatGPT plan.
  id?: "openai" | "chatgpt";
  apiKey?: string;
  // The plan route's access token, refreshed by the caller as needed.
  token?: () => Promise<string>;
  baseUrl?: string;
  fetch?: typeof fetch;
  overrides?: Record<string, Capabilities>;
  maxRetries?: number;
};

export class OpenAIProvider implements Provider {
  readonly id: "openai" | "chatgpt";
  readonly route: "api-key" | "chatgpt-plan";
  private readonly opts: OpenAIOptions;
  private readonly overrides: Record<string, Capabilities>;

  constructor(opts: OpenAIOptions = {}) {
    this.id = opts.id ?? "openai";
    this.route = this.id === "chatgpt" ? "chatgpt-plan" : "api-key";
    if (this.id === "openai" && !opts.apiKey)
      throw new ProviderError(
        "auth",
        "no OpenAI API key",
        "set OPENAI_API_KEY, or use your ChatGPT plan: `teh login chatgpt`",
      );
    if (this.id === "chatgpt" && !opts.token)
      throw new ProviderError("auth", "not signed in to ChatGPT", "run `teh login chatgpt`");
    this.opts = opts;
    this.overrides = opts.overrides ?? {};
  }

  private async client(): Promise<OpenAI> {
    const apiKey = this.opts.token ? await this.opts.token() : (this.opts.apiKey as string);
    return new OpenAI({
      apiKey,
      baseURL: this.opts.baseUrl ?? OPENAI_BASE_URL,
      // The plan route asks clients not to retry blindly; usage-limit errors must stop.
      maxRetries: this.id === "chatgpt" ? 0 : (this.opts.maxRetries ?? 2),
      ...(this.opts.fetch ? { fetch: this.opts.fetch } : {}),
    });
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      if (this.id === "chatgpt") {
        // The plan route lists models as {models: [{slug, display_name, visibility}]}.
        const token = await (this.opts.token as () => Promise<string>)();
        const f = this.opts.fetch ?? fetch;
        const res = await f(`${this.opts.baseUrl ?? OPENAI_BASE_URL}/models`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (!res.ok) throw mapHttpError("chatgpt", res.status, await res.text());
        const body = (await res.json()) as { models?: { slug: string; visibility?: string }[] };
        return (body.models ?? [])
          .filter((m) => m.visibility === undefined || m.visibility === "list")
          .map((m) => this.info(m.slug));
      }
      const out: ModelInfo[] = [];
      for await (const m of (await this.client()).models.list()) out.push(this.info(m.id));
      return out.filter((m) => m.supportsTools);
    } catch (e) {
      throw mapError(this.id, e);
    }
  }

  private info(id: string): ModelInfo {
    const caps = capabilities(this.id, id, this.overrides);
    // Without a registry entry we cannot tell an embedding model from a chat model; the plan
    // route only lists chat models.
    const supportsTools = this.id === "chatgpt" || caps !== undefined;
    return { id, supportsTools, ...(caps?.context ? { contextWindow: caps.context } : {}) };
  }

  async probe(model: string): Promise<ProbeResult> {
    const caps = capabilities(this.id, model, this.overrides);
    const notes: string[] = [];
    if (!caps) notes.push(`${model} is not in teh's model registry; context size and prices are unknown`);
    return {
      supportsTools: true,
      ...(caps?.context ? { contextWindow: caps.context } : {}),
      vision: caps?.vision ?? false,
      notes,
    };
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const plan = this.id === "chatgpt";
    const caps = capabilities(this.id, req.model, this.overrides);
    const params: ResponseCreateParamsStreaming = {
      model: req.model,
      instructions: req.system,
      input: toResponsesInput(req.items, this.id),
      store: false,
      stream: true,
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              type: "function" as const,
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
              strict: false,
            })),
          }
        : {}),
      ...(caps?.reasoning ? { reasoning: { summary: "auto" }, include: ["reasoning.encrypted_content"] } : {}),
      ...(!plan && req.maxOutputTokens ? { max_output_tokens: req.maxOutputTokens } : {}),
      ...(!plan && req.temperature !== undefined && !caps?.reasoning ? { temperature: req.temperature } : {}),
      ...(!plan && req.json ? { text: { format: { type: "json_object" } } } : {}),
    };

    let stream: AsyncIterable<ResponseStreamEvent>;
    try {
      stream = await (await this.client()).responses.create(params, signal ? { signal } : {});
    } catch (e) {
      throw mapError(this.id, e);
    }

    let stop: StopReason | undefined;
    let calls = 0;
    try {
      for await (const ev of stream) {
        if (ev.type === "response.output_text.delta") yield { type: "text_delta", text: ev.delta };
        else if (ev.type === "response.reasoning_summary_text.delta") yield { type: "reasoning_delta", text: ev.delta };
        else if (ev.type === "response.output_item.done") {
          const item = ev.item;
          if (item.type === "function_call") {
            calls++;
            yield { type: "tool_call", id: item.call_id, name: item.name, args: parseArgs(item.arguments) };
          } else if (item.type === "reasoning") {
            const text = (item.summary ?? []).map((s) => s.text).join("\n\n");
            yield {
              type: "reasoning",
              ...(text ? { text } : {}),
              opaque: {
                type: "reasoning",
                id: item.id,
                summary: item.summary ?? [],
                ...(item.encrypted_content ? { encrypted_content: item.encrypted_content } : {}),
              },
            };
          }
        } else if (ev.type === "response.completed" || ev.type === "response.incomplete") {
          const u = ev.response.usage;
          if (u) {
            const cached = u.input_tokens_details?.cached_tokens ?? 0;
            yield {
              type: "usage",
              usage: { input: u.input_tokens - cached, cachedRead: cached, cacheWrite: 0, output: u.output_tokens },
            };
          }
          stop =
            ev.type === "response.incomplete"
              ? ev.response.incomplete_details?.reason === "content_filter"
                ? "refusal"
                : "max_tokens"
              : calls > 0
                ? "tool_use"
                : "end";
        } else if (ev.type === "response.failed") {
          const err = ev.response.error;
          throw mapHttpError(this.id, statusFor(err?.code), `${err?.code ?? "failed"}: ${err?.message ?? ""}`);
        } else if (ev.type === "error") {
          throw mapHttpError(this.id, statusFor(ev.code ?? undefined), `${ev.code ?? "error"}: ${ev.message}`);
        }
      }
    } catch (e) {
      throw mapError(this.id, e);
    }
    // A stream that ends without response.completed is a failure (plan-route docs).
    if (!stop) throw new ProviderError("unavailable", `${this.id}: the response stream ended early`, "try again");
    yield { type: "stop", reason: stop };
  }
}

// Error codes in a failed stream, mapped to the HTTP status they stand for.
function statusFor(code: string | null | undefined): number | undefined {
  if (!code) return undefined;
  if (/usage_limit|rate_limit/.test(code)) return 429;
  if (/unavailable|server_error/.test(code)) return 503;
  if (/invalid_user|not_eligible|scope|authorization|route_not_supported/.test(code)) return 403;
  if (/context_length/.test(code)) return 413;
  return 400;
}

function parseArgs(json: string): unknown {
  if (!json?.trim()) return {};
  try {
    return JSON.parse(json);
  } catch {
    return { _unparsed: json };
  }
}

// Canonical items to Responses input items. Reasoning goes back only to the route that made it.
export function toResponsesInput(items: Item[], provider: string): ResponseInputItem[] {
  const out: ResponseInputItem[] = [];
  for (const item of items) {
    if (item.kind === "text") {
      if (!item.text) continue;
      out.push(
        item.role === "user"
          ? { role: "user", content: [{ type: "input_text", text: item.text }] }
          : { role: "assistant", content: item.text },
      );
    } else if (item.kind === "tool_call") {
      out.push({
        type: "function_call",
        call_id: item.id,
        name: item.name,
        arguments: JSON.stringify(item.args ?? {}),
      });
    } else if (item.kind === "tool_result") {
      const output: string | ResponseFunctionCallOutputItemList = item.images?.length
        ? [
            { type: "input_text", text: item.content },
            ...item.images.map((i) => ({
              type: "input_image" as const,
              image_url: `data:${i.mediaType};base64,${i.data}`,
              detail: "auto" as const,
            })),
          ]
        : item.content || "(no output)";
      out.push({ type: "function_call_output", call_id: item.callId, output });
    } else if (item.provider === provider && item.opaque) {
      out.push(item.opaque as ResponseInputItem);
    }
  }
  return out;
}

function mapError(provider: string, e: unknown): unknown {
  if (e instanceof ProviderError || (e as Error)?.name === "AbortError") return e;
  if (e instanceof OpenAI.APIUserAbortError) {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  }
  if (e instanceof OpenAI.APIConnectionError)
    return new ProviderError("unavailable", `cannot reach ${provider}: ${e.message}`, "check your network");
  if (e instanceof OpenAI.APIError) {
    const code = (e as { code?: string | null }).code ?? "";
    return mapHttpError(provider, e.status, `${code ? `${code}: ` : ""}${e.message}`);
  }
  return e;
}
