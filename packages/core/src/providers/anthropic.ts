// Anthropic Messages API adapter (ADR-0002), over the official SDK.
// - Prompt caching: a breakpoint on the system prompt (which covers the tools before it) and one
//   on the last block of the conversation, so each request reads the previous one's prefix.
// - Thinking: adaptive thinking with summaries on models that support it. Thinking blocks come
//   back as opaque reasoning items and are replayed unchanged, in order, to Anthropic only.
// - Server-side refusal fallbacks are not enabled: a pinned model must not quietly become another
//   one (ADR-0014). A refusal stops the turn and is shown.
import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  ImageBlockParam,
  MessageCreateParamsStreaming,
  MessageParam,
  TextBlockParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages";
import { type Item, type ModelRequest, ProviderError, type StopReason, type StreamEvent } from "../types";
import { mapHttpError } from "./errors";
import type { ModelInfo, ProbeResult, Provider } from "./provider";
import { type Capabilities, capabilities } from "./registry";

export type AnthropicOptions = {
  apiKey?: string;
  baseUrl?: string;
  // For tests: a fetch that plays recorded responses.
  fetch?: typeof fetch;
  overrides?: Record<string, Capabilities>;
  maxRetries?: number;
};

const DEFAULT_MAX_OUTPUT = 64_000;

// Claude 4.6 and later take adaptive thinking; older models would need a token budget, which we
// do not send (they run without thinking).
export function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(fable|mythos|opus|sonnet|haiku)-(5|4-[6-9])/.test(model);
}

type Opaque = { type: "thinking"; thinking: string; signature: string } | { type: "redacted_thinking"; data: string };

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly route = "api-key" as const;
  private readonly client: Anthropic;
  private readonly overrides: Record<string, Capabilities>;

  constructor(opts: AnthropicOptions = {}) {
    if (!opts.apiKey)
      throw new ProviderError(
        "auth",
        "no Anthropic API key",
        "set ANTHROPIC_API_KEY (from console.anthropic.com); Claude subscriptions are used through your own Claude Code, not here",
      );
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
      ...(opts.fetch ? { fetch: opts.fetch } : {}),
      maxRetries: opts.maxRetries ?? 2,
    });
    this.overrides = opts.overrides ?? {};
  }

  async listModels(): Promise<ModelInfo[]> {
    try {
      const out: ModelInfo[] = [];
      for await (const m of this.client.models.list()) {
        const window = (m as { max_input_tokens?: number }).max_input_tokens;
        out.push({ id: m.id, supportsTools: true, ...(window ? { contextWindow: window } : {}) });
      }
      return out;
    } catch (e) {
      throw mapError(e);
    }
  }

  async probe(model: string): Promise<ProbeResult> {
    const caps = capabilities("anthropic", model, this.overrides);
    const notes: string[] = [];
    if (!caps) notes.push(`${model} is not in teh's model registry; context size and prices are unknown`);
    return {
      supportsTools: true,
      ...(caps?.context ? { contextWindow: caps.context } : {}),
      vision: caps?.vision ?? true,
      notes,
    };
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const caps = capabilities("anthropic", req.model, this.overrides);
    const adaptive = supportsAdaptiveThinking(req.model);
    const params: MessageCreateParamsStreaming = {
      model: req.model,
      max_tokens: req.maxOutputTokens ?? Math.min(caps?.output ?? DEFAULT_MAX_OUTPUT, DEFAULT_MAX_OUTPUT),
      system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
      messages: toAnthropicMessages(req.items),
      stream: true,
      ...(req.tools.length
        ? {
            tools: req.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.inputSchema as { type: "object"; [k: string]: unknown },
            })),
          }
        : {}),
      ...(adaptive ? { thinking: { type: "adaptive", display: "summarized" } } : {}),
      // Sampling parameters are rejected on current models; only older ones get a temperature.
      ...(!adaptive && req.temperature !== undefined ? { temperature: req.temperature } : {}),
    };

    let stream: AsyncIterable<Anthropic.RawMessageStreamEvent>;
    try {
      stream = await this.client.messages.create(params, signal ? { signal } : {});
    } catch (e) {
      throw mapError(e);
    }

    // Blocks being built, by index.
    const blocks = new Map<number, { type: string; text: string; signature?: string; id?: string; name?: string }>();
    let stop: StopReason = "end";
    let calls = 0;
    try {
      for await (const ev of stream) {
        switch (ev.type) {
          case "message_start": {
            const u = ev.message.usage;
            yield {
              type: "usage",
              usage: {
                input: u.input_tokens ?? 0,
                cachedRead: u.cache_read_input_tokens ?? 0,
                cacheWrite: u.cache_creation_input_tokens ?? 0,
                output: u.output_tokens ?? 0,
              },
            };
            break;
          }
          case "content_block_start": {
            const b = ev.content_block;
            if (b.type === "tool_use") blocks.set(ev.index, { type: "tool_use", text: "", id: b.id, name: b.name });
            else if (b.type === "redacted_thinking")
              yield { type: "reasoning", opaque: { type: "redacted_thinking", data: b.data } satisfies Opaque };
            else if (b.type === "thinking") blocks.set(ev.index, { type: "thinking", text: b.thinking ?? "" });
            else if (b.type === "text") {
              blocks.set(ev.index, { type: "text", text: "" });
              if (b.text) yield { type: "text_delta", text: b.text };
            }
            break;
          }
          case "content_block_delta": {
            const b = blocks.get(ev.index);
            const d = ev.delta;
            if (d.type === "text_delta") yield { type: "text_delta", text: d.text };
            else if (d.type === "thinking_delta" && b) {
              b.text += d.thinking;
              if (d.thinking) yield { type: "reasoning_delta", text: d.thinking };
            } else if (d.type === "signature_delta" && b) b.signature = (b.signature ?? "") + d.signature;
            else if (d.type === "input_json_delta" && b) b.text += d.partial_json;
            break;
          }
          case "content_block_stop": {
            const b = blocks.get(ev.index);
            blocks.delete(ev.index);
            if (b?.type === "thinking") {
              const opaque: Opaque = { type: "thinking", thinking: b.text, signature: b.signature ?? "" };
              yield { type: "reasoning", ...(b.text ? { text: b.text } : {}), opaque };
            } else if (b?.type === "tool_use") {
              calls++;
              yield { type: "tool_call", id: b.id ?? "", name: b.name ?? "", args: parseArgs(b.text) };
            }
            break;
          }
          case "message_delta": {
            const u = ev.usage;
            yield {
              type: "usage",
              usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: u.output_tokens ?? 0 },
            };
            stop = stopReason(ev.delta.stop_reason, calls);
            break;
          }
        }
      }
    } catch (e) {
      throw mapError(e);
    }
    yield { type: "stop", reason: stop === "end" && calls > 0 ? "tool_use" : stop };
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

function stopReason(r: string | null | undefined, calls: number): StopReason {
  if (r === "tool_use" || calls > 0) return "tool_use";
  if (r === "max_tokens" || r === "model_context_window_exceeded") return "max_tokens";
  if (r === "refusal") return "refusal";
  return "end";
}

// Canonical items to Anthropic messages. Consecutive assistant items form one assistant message;
// tool results and user text form user messages, results first.
export function toAnthropicMessages(items: Item[]): MessageParam[] {
  const out: MessageParam[] = [];
  const push = (role: "user" | "assistant", block: ContentBlockParam) => {
    const last = out.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(block);
    else out.push({ role, content: [block] });
  };
  for (const item of items) {
    if (item.kind === "reasoning") {
      // Only Anthropic's own thinking goes back, unchanged; anything else is dropped.
      if (item.provider === "anthropic" && item.opaque) push("assistant", item.opaque as Opaque);
    } else if (item.kind === "tool_call") {
      push("assistant", {
        type: "tool_use",
        id: item.id,
        name: item.name,
        input: (item.args ?? {}) as Record<string, unknown>,
      });
    } else if (item.kind === "text") {
      if (!item.text) continue;
      push(item.role, { type: "text", text: item.text });
    } else {
      const content: (TextBlockParam | ImageBlockParam)[] = [{ type: "text", text: item.content || "(no output)" }];
      for (const img of item.images ?? [])
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType as "image/png", data: img.data },
        });
      const block: ToolResultBlockParam = {
        type: "tool_result",
        tool_use_id: item.callId,
        content,
        ...(item.isError ? { is_error: true } : {}),
      };
      // Tool results lead their user message.
      const last = out.at(-1);
      if (last?.role === "user" && Array.isArray(last.content)) {
        const firstNonResult = last.content.findIndex((b) => b.type !== "tool_result");
        if (firstNonResult >= 0) last.content.splice(firstNonResult, 0, block);
        else last.content.push(block);
      } else out.push({ role: "user", content: [block] });
    }
  }
  // Cache everything up to the newest block.
  const last = out.at(-1);
  if (last && Array.isArray(last.content)) {
    const tail = last.content.at(-1) as { cache_control?: unknown; type: string } | undefined;
    if (tail && tail.type !== "thinking" && tail.type !== "redacted_thinking")
      tail.cache_control = { type: "ephemeral" };
  }
  return out;
}

function mapError(e: unknown): unknown {
  if (e instanceof ProviderError || (e as Error)?.name === "AbortError") return e;
  if (e instanceof Anthropic.APIUserAbortError) {
    const err = new Error("aborted");
    err.name = "AbortError";
    return err;
  }
  if (e instanceof Anthropic.APIConnectionError)
    return new ProviderError("unavailable", `cannot reach the Anthropic API: ${e.message}`, "check your network");
  if (e instanceof Anthropic.APIError) {
    // Prefer the API's own message over the SDK's "401 {json}" rendering.
    const body = e.error as { error?: { message?: string } } | undefined;
    return mapHttpError("anthropic", e.status, body?.error?.message ?? e.message);
  }
  return e;
}
