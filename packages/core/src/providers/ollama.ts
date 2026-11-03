// Native Ollama adapter (/api/chat). We use the native API rather than Ollama's
// OpenAI-compatible endpoint so we can set num_ctx: Ollama's default window can be
// as small as 4k and it truncates longer prompts silently (docs/research/12 §3).
import { type Item, type ModelRequest, ProviderError, type StreamEvent } from "../types";
import type { ModelInfo, ProbeResult, Provider } from "./provider";

export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
// Ollama recommends at least 64k for agents and coding tools.
export const DEFAULT_NUM_CTX = 65_536;
const MIN_USEFUL_CTX = 16_384;

export type OllamaOptions = { baseUrl?: string; numCtx?: number };

type OllamaMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  thinking?: string;
  tool_calls?: { function: { name: string; arguments: unknown } }[];
  tool_name?: string;
};

type ShowResponse = { capabilities?: string[]; model_info?: Record<string, unknown> };

export function ollamaBaseUrl(env: Record<string, string | undefined> = process.env): string {
  const host = env.OLLAMA_HOST?.trim();
  if (!host) return DEFAULT_OLLAMA_URL;
  return (host.includes("://") ? host : `http://${host}`).replace(/\/+$/, "");
}

export class OllamaProvider implements Provider {
  readonly id = "ollama";
  private readonly baseUrl: string;
  private readonly numCtx: number;
  private readonly shown = new Map<string, Promise<ShowResponse>>();

  constructor(opts: OllamaOptions = {}) {
    this.baseUrl = opts.baseUrl ?? ollamaBaseUrl();
    this.numCtx = opts.numCtx ?? DEFAULT_NUM_CTX;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.fetch("/api/tags", { method: "GET" });
    const body = (await res.json()) as {
      models?: { name: string; capabilities?: string[]; details?: { context_length?: number } }[];
    };
    return (body.models ?? []).map((m) => ({
      id: m.name,
      ...(m.capabilities ? { supportsTools: m.capabilities.includes("tools") } : {}),
      ...(m.details?.context_length ? { contextWindow: m.details.context_length } : {}),
    }));
  }

  async probe(model: string): Promise<ProbeResult> {
    const info = await this.show(model);
    const notes: string[] = [];
    const supportsTools = info.capabilities?.includes("tools") ?? false;
    if (!supportsTools)
      notes.push(`${model} does not advertise tool calling; pick a model with the "tools" capability`);
    const contextWindow = await this.contextFor(model);
    if (contextWindow < MIN_USEFUL_CTX) {
      notes.push(`${model} has a ${contextWindow}-token window; coding agents need at least ${MIN_USEFUL_CTX}`);
    }
    return { supportsTools, contextWindow, notes };
  }

  async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
    const numCtx = Math.min(await this.contextFor(req.model), req.contextTokens ?? Number.POSITIVE_INFINITY);
    const estimate = estimateTokens(req);
    if (estimate > numCtx * 0.9) {
      throw new ProviderError(
        "context_exceeded",
        `request is ~${estimate} tokens but ${req.model} is running with a ${numCtx}-token window`,
        "raise it with TEH_OLLAMA_NUM_CTX (and OLLAMA_CONTEXT_LENGTH for other clients), or use a model with a larger window",
      );
    }

    const res = await this.fetch(
      "/api/chat",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: req.model,
          messages: toOllamaMessages(req.system, req.items),
          tools: req.tools.map((t) => ({
            type: "function",
            function: { name: t.name, description: t.description, parameters: t.inputSchema },
          })),
          stream: true,
          ...(req.json ? { format: "json" } : {}),
          options: {
            num_ctx: numCtx,
            ...(req.maxOutputTokens ? { num_predict: req.maxOutputTokens } : {}),
            ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
          },
        }),
        ...(signal ? { signal } : {}),
      },
      req.model,
    );

    let calls = 0;
    for await (const chunk of ndjson(res)) {
      if (typeof chunk.error === "string") throw new ProviderError("bad_request", `ollama: ${chunk.error}`);
      const msg = chunk.message as OllamaMessage | undefined;
      if (msg?.thinking) yield { type: "reasoning_delta", text: msg.thinking };
      if (msg?.content) yield { type: "text_delta", text: msg.content };
      for (const call of msg?.tool_calls ?? []) {
        yield {
          type: "tool_call",
          id: `ollama_call_${++calls}`,
          name: call.function.name,
          args: call.function.arguments,
        };
      }
      if (chunk.done) {
        yield {
          type: "usage",
          usage: {
            input: Number(chunk.prompt_eval_count ?? 0),
            cachedRead: 0,
            cacheWrite: 0,
            output: Number(chunk.eval_count ?? 0),
          },
        };
        const reason = calls > 0 ? "tool_use" : chunk.done_reason === "length" ? "max_tokens" : "end";
        yield { type: "stop", reason };
      }
    }
  }

  async embed(model: string, inputs: string[]): Promise<number[][]> {
    const res = await this.fetch(
      "/api/embed",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, input: inputs }),
      },
      model,
    );
    const body = (await res.json()) as { embeddings?: number[][]; error?: string };
    if (!body.embeddings) throw new ProviderError("bad_request", `ollama: ${body.error ?? "no embeddings returned"}`);
    return body.embeddings;
  }

  // The window we will actually request: our default, capped at the model's maximum.
  private async contextFor(model: string): Promise<number> {
    const info = await this.show(model);
    const max = Object.entries(info.model_info ?? {}).find(([k]) => k.endsWith(".context_length"))?.[1];
    return typeof max === "number" ? Math.min(this.numCtx, max) : this.numCtx;
  }

  private show(model: string): Promise<ShowResponse> {
    let p = this.shown.get(model);
    if (!p) {
      p = this.fetch(
        "/api/show",
        { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model }) },
        model,
      ).then((r) => r.json() as Promise<ShowResponse>);
      p.catch(() => this.shown.delete(model));
      this.shown.set(model, p);
    }
    return p;
  }

  private async fetch(path: string, init: RequestInit, model?: string): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.baseUrl + path, init);
    } catch (e) {
      if ((e as Error).name === "AbortError") throw e;
      throw new ProviderError(
        "unavailable",
        `cannot reach Ollama at ${this.baseUrl}`,
        "start it with `ollama serve` (or the Ollama app), or set OLLAMA_HOST",
      );
    }
    if (res.ok) return res;
    const detail = await res.text().catch(() => "");
    if (res.status === 404 && model) {
      throw new ProviderError("bad_request", `Ollama has no model "${model}"`, `run \`ollama pull ${model}\``);
    }
    throw new ProviderError(res.status >= 500 ? "overloaded" : "bad_request", `ollama ${res.status}: ${detail}`);
  }
}

export function toOllamaMessages(system: string, items: Item[]): OllamaMessage[] {
  const out: OllamaMessage[] = [{ role: "system", content: system }];
  let assistant: OllamaMessage | undefined;
  for (const item of items) {
    if (item.kind === "tool_call" || (item.kind === "text" && item.role === "assistant") || item.kind === "reasoning") {
      if (!assistant) {
        assistant = { role: "assistant", content: "" };
        out.push(assistant);
      }
      if (item.kind === "text") assistant.content += item.text;
      else if (item.kind === "tool_call") {
        assistant.tool_calls = [
          ...(assistant.tool_calls ?? []),
          { function: { name: item.name, arguments: item.args } },
        ];
      } else if (item.provider === "ollama" && item.text) assistant.thinking = (assistant.thinking ?? "") + item.text;
      continue;
    }
    assistant = undefined;
    if (item.kind === "text") out.push({ role: "user", content: item.text });
    else out.push({ role: "tool", content: item.content, tool_name: item.name });
  }
  return out;
}

// Rough token estimate (~4 chars per token), enough to catch a window that is far too small.
export function estimateTokens(req: ModelRequest): number {
  const chars = req.system.length + JSON.stringify(req.items).length + JSON.stringify(req.tools).length;
  return Math.ceil(chars / 4);
}

async function* ndjson(res: Response): AsyncIterable<Record<string, unknown>> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl = buffer.indexOf("\n");
    while (nl >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line) yield JSON.parse(line);
      nl = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield JSON.parse(buffer);
}
