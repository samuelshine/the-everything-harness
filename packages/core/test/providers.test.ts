// Contract tests for the cloud and OpenAI-compatible adapters (ADR-0002), played from recorded
// HTTP responses so they run without keys.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  AnthropicProvider,
  CompatibleProvider,
  capabilities,
  costUsd,
  createProvider,
  type Item,
  OpenAIProvider,
  ProviderError,
  routeOf,
  type StreamEvent,
  supportsAdaptiveThinking,
  toAnthropicMessages,
  toChatMessages,
  toResponsesInput,
} from "../src";

type Recorded = { status?: number; body: string; headers?: Record<string, string> };

// A fetch that answers each request with the next recorded response and keeps what was sent.
function recorder(responses: Recorded[]) {
  const sent: { url: string; body: unknown; headers: Headers }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const text = init?.body !== undefined ? String(init.body) : await req.text();
    sent.push({ url: req.url, body: text ? JSON.parse(text) : undefined, headers: new Headers(init?.headers) });
    const r = responses.shift();
    if (!r) throw new Error(`no recorded response for ${req.url}`);
    const sse = r.body.startsWith("event:") || r.body.startsWith("data:");
    return new Response(r.body, {
      status: r.status ?? 200,
      headers: { "content-type": sse ? "text/event-stream" : "application/json", ...r.headers },
    });
  }) as typeof fetch;
  return { f, sent };
}

const sse = (events: [string | null, unknown][]) =>
  `${events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`).join("")}`;

async function collect(it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const req = (items: Item[], extra = {}) => ({
  model: "claude-sonnet-5-5",
  system: "You are teh.",
  items,
  tools: [{ name: "Read", description: "Read a file", inputSchema: { type: "object", properties: {} } }],
  ...extra,
});

describe("anthropic", () => {
  const stream = sse([
    [
      "message_start",
      {
        type: "message_start",
        message: {
          id: "msg_1",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-5-5",
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, cache_read_input_tokens: 900, cache_creation_input_tokens: 30, output_tokens: 1 },
        },
      },
    ],
    [
      "content_block_start",
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "" } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Look at the file." } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig123" } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["content_block_start", { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } }],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Reading it." } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 1 }],
    [
      "content_block_start",
      {
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_1", name: "Read", input: {} },
      },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '{"file_path":' } },
    ],
    [
      "content_block_delta",
      { type: "content_block_delta", index: 2, delta: { type: "input_json_delta", partial_json: '"a.ts"}' } },
    ],
    ["content_block_stop", { type: "content_block_stop", index: 2 }],
    [
      "message_delta",
      { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 40 } },
    ],
    ["message_stop", { type: "message_stop" }],
  ]);

  test("streams thinking with its signature, text and a tool call, in order", async () => {
    const { f, sent } = recorder([{ body: stream }]);
    const p = new AnthropicProvider({ apiKey: "sk-test", fetch: f, maxRetries: 0 });
    const events = await collect(p.stream(req([{ kind: "text", role: "user", text: "read a.ts" }])));
    expect(events.filter((e) => e.type !== "usage")).toEqual([
      { type: "reasoning_delta", text: "Look at the file." },
      {
        type: "reasoning",
        text: "Look at the file.",
        opaque: { type: "thinking", thinking: "Look at the file.", signature: "sig123" },
      },
      { type: "text_delta", text: "Reading it." },
      { type: "tool_call", id: "toolu_1", name: "Read", args: { file_path: "a.ts" } },
      { type: "stop", reason: "tool_use" },
    ]);
    const usage = events.filter((e) => e.type === "usage");
    expect(usage[0]).toEqual({ type: "usage", usage: { input: 12, cachedRead: 900, cacheWrite: 30, output: 1 } });
    // The request: cached system prompt, adaptive thinking with summaries, no sampling parameters.
    const body = sent[0]?.body as Record<string, unknown>;
    expect(sent[0]?.url).toEndWith("/v1/messages");
    expect(body.system).toEqual([{ type: "text", text: "You are teh.", cache_control: { type: "ephemeral" } }]);
    expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(body.temperature).toBeUndefined();
    expect(body.stream).toBe(true);
  });

  test("replays only Anthropic's own thinking, unchanged, with tool results leading the user turn", () => {
    const msgs = toAnthropicMessages([
      { kind: "text", role: "user", text: "go" },
      {
        kind: "reasoning",
        provider: "anthropic",
        text: "t",
        opaque: { type: "thinking", thinking: "t", signature: "s" },
      },
      { kind: "reasoning", provider: "ollama", text: "local thoughts" },
      { kind: "tool_call", id: "a", name: "Read", args: { file_path: "x" } },
      { kind: "tool_result", callId: "a", name: "Read", content: "x contents" },
      { kind: "text", role: "user", text: "(note)" },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(msgs[1]?.content).toEqual([
      { type: "thinking", thinking: "t", signature: "s" },
      { type: "tool_use", id: "a", name: "Read", input: { file_path: "x" } },
    ]);
    const last = msgs[2]?.content as { type: string; cache_control?: unknown }[];
    expect(last.map((b) => b.type)).toEqual(["tool_result", "text"]);
    expect(last.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
  });

  test("sends tool-result images as image blocks", () => {
    const msgs = toAnthropicMessages([
      { kind: "tool_call", id: "a", name: "Read", args: {} },
      {
        kind: "tool_result",
        callId: "a",
        name: "Read",
        content: "an image",
        images: [{ mediaType: "image/png", data: "AAAA" }],
      },
    ]);
    const result = ((msgs[1] as { content: unknown }).content as { content: { type: string }[] }[])[0];
    expect(result?.content.map((b) => b.type)).toEqual(["text", "image"]);
  });

  test("maps errors onto the taxonomy", async () => {
    const cases: [number, string, string][] = [
      [401, "invalid x-api-key", "auth"],
      [429, "rate limited", "rate_limited"],
      [529, "Overloaded", "overloaded"],
      [400, "prompt is too long: 250000 tokens > 200000 maximum", "context_exceeded"],
      [400, "messages: bad", "bad_request"],
    ];
    for (const [status, message, kind] of cases) {
      const { f } = recorder([{ status, body: JSON.stringify({ type: "error", error: { type: "x", message } }) }]);
      const p = new AnthropicProvider({ apiKey: "sk-test", fetch: f, maxRetries: 0 });
      const err = await collect(p.stream(req([{ kind: "text", role: "user", text: "hi" }]))).catch((e) => e);
      expect(err).toBeInstanceOf(ProviderError);
      expect((err as ProviderError).kind).toBe(kind as ProviderError["kind"]);
    }
  });

  test("needs a key, and says where Claude subscriptions go instead", () => {
    const err = (() => {
      try {
        createProvider("anthropic", {});
      } catch (e) {
        return e as ProviderError;
      }
    })();
    expect(err?.kind).toBe("auth");
    expect(err?.hint).toContain("Claude Code");
  });

  test("adaptive thinking only on models that take it", () => {
    expect(supportsAdaptiveThinking("claude-opus-5-5")).toBe(true);
    expect(supportsAdaptiveThinking("claude-sonnet-4-6")).toBe(true);
    expect(supportsAdaptiveThinking("claude-haiku-4-5")).toBe(false);
    expect(supportsAdaptiveThinking("claude-opus-4-5-20251101")).toBe(false);
  });
});

describe("openai responses", () => {
  const stream = sse([
    [null, { type: "response.created", sequence_number: 0, response: { id: "resp_1", output: [] } }],
    [null, { type: "response.reasoning_summary_text.delta", delta: "Plan it.", item_id: "rs_1", sequence_number: 1 }],
    [
      null,
      {
        type: "response.output_item.done",
        sequence_number: 2,
        output_index: 0,
        item: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Plan it." }],
          encrypted_content: "ENC",
        },
      },
    ],
    [null, { type: "response.output_text.delta", delta: "Looking.", item_id: "msg_1", sequence_number: 3 }],
    [
      null,
      {
        type: "response.output_item.done",
        sequence_number: 4,
        output_index: 2,
        item: { type: "function_call", id: "fc_1", call_id: "call_1", name: "Read", arguments: '{"file_path":"a.ts"}' },
      },
    ],
    [
      null,
      {
        type: "response.completed",
        sequence_number: 5,
        response: {
          id: "resp_1",
          status: "completed",
          output: [],
          usage: {
            input_tokens: 1000,
            input_tokens_details: { cached_tokens: 800 },
            output_tokens: 50,
            output_tokens_details: { reasoning_tokens: 20 },
            total_tokens: 1050,
          },
        },
      },
    ],
  ]);

  test("streams reasoning (encrypted), text and a tool call; usage splits out cached input", async () => {
    const { f, sent } = recorder([{ body: stream }]);
    const p = new OpenAIProvider({ apiKey: "sk-test", fetch: f, maxRetries: 0 });
    const events = await collect(
      p.stream({ ...req([{ kind: "text", role: "user", text: "read a.ts" }]), model: "gpt-6.1-sol", temperature: 0 }),
    );
    expect(events).toEqual([
      { type: "reasoning_delta", text: "Plan it." },
      {
        type: "reasoning",
        text: "Plan it.",
        opaque: {
          type: "reasoning",
          id: "rs_1",
          summary: [{ type: "summary_text", text: "Plan it." }],
          encrypted_content: "ENC",
        },
      },
      { type: "text_delta", text: "Looking." },
      { type: "tool_call", id: "call_1", name: "Read", args: { file_path: "a.ts" } },
      { type: "usage", usage: { input: 200, cachedRead: 800, cacheWrite: 0, output: 50 } },
      { type: "stop", reason: "tool_use" },
    ]);
    const body = sent[0]?.body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.instructions).toBe("You are teh.");
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
    // A reasoning model takes no temperature.
    expect(body.temperature).toBeUndefined();
  });

  test("the ChatGPT plan profile leaves out fields the plan route rejects", async () => {
    const { f, sent } = recorder([{ body: stream }]);
    const p = new OpenAIProvider({ id: "chatgpt", token: async () => "tok", fetch: f });
    await collect(
      p.stream({
        ...req([{ kind: "text", role: "user", text: "hi" }]),
        model: "gpt-6.1-sol",
        maxOutputTokens: 100,
        json: true,
      }),
    );
    const body = sent[0]?.body as Record<string, unknown>;
    expect(body.store).toBe(false);
    expect(body.stream).toBe(true);
    for (const k of ["max_output_tokens", "temperature", "metadata", "previous_response_id", "text"])
      expect(body[k]).toBeUndefined();
    expect(sent[0]?.headers.get("authorization")).toBe("Bearer tok");
    expect(p.route).toBe("chatgpt-plan");
  });

  test("a plan usage limit stops with the Manage usage link", async () => {
    const failed = sse([
      [
        null,
        {
          type: "response.failed",
          sequence_number: 1,
          response: { id: "r", error: { code: "subscription_sharing_usage_limit_exceeded", message: "limit" } },
        },
      ],
    ]);
    const { f } = recorder([{ body: failed }]);
    const p = new OpenAIProvider({ id: "chatgpt", token: async () => "tok", fetch: f });
    const err = (await collect(p.stream({ ...req([]), model: "gpt-6.1-sol" })).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("rate_limited");
    expect(err.hint).toContain("chatgpt.com/settings/usage");
  });

  test("a stream that ends without response.completed is an error", async () => {
    const { f } = recorder([
      { body: sse([[null, { type: "response.output_text.delta", delta: "hi", sequence_number: 1 }]]) },
    ]);
    const p = new OpenAIProvider({ apiKey: "k", fetch: f, maxRetries: 0 });
    const err = (await collect(p.stream({ ...req([]), model: "gpt-6.1-sol" })).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("unavailable");
  });

  test("history: reasoning only back to its own route; images in function output", () => {
    const items: Item[] = [
      { kind: "text", role: "user", text: "go" },
      {
        kind: "reasoning",
        provider: "openai",
        opaque: { type: "reasoning", id: "rs", summary: [], encrypted_content: "E" },
      },
      { kind: "reasoning", provider: "anthropic", opaque: { type: "thinking" } },
      { kind: "text", role: "assistant", text: "ok" },
      { kind: "tool_call", id: "c1", name: "Read", args: { a: 1 } },
      {
        kind: "tool_result",
        callId: "c1",
        name: "Read",
        content: "img",
        images: [{ mediaType: "image/png", data: "QQ" }],
      },
    ];
    const input = toResponsesInput(items, "openai");
    expect(input).toEqual([
      { role: "user", content: [{ type: "input_text", text: "go" }] },
      { type: "reasoning", id: "rs", summary: [], encrypted_content: "E" },
      { role: "assistant", content: "ok" },
      { type: "function_call", call_id: "c1", name: "Read", arguments: '{"a":1}' },
      {
        type: "function_call_output",
        call_id: "c1",
        output: [
          { type: "input_text", text: "img" },
          { type: "input_image", image_url: "data:image/png;base64,QQ", detail: "auto" },
        ],
      },
    ]);
    // On the plan route the API key's reasoning is not replayed.
    expect(toResponsesInput(items, "chatgpt").some((i) => (i as { type?: string }).type === "reasoning")).toBe(false);
  });
});

describe("openai-compatible", () => {
  const chunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: unknown) => ({
    id: "c",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
    ...(usage ? { usage } : {}),
  });
  const stream = sse([
    [null, chunk({ role: "assistant", reasoning_content: "hmm" })],
    [null, chunk({ content: "Let me look." })],
    [
      null,
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "Read", arguments: "" } }] }),
    ],
    [null, chunk({ tool_calls: [{ index: 0, function: { arguments: '{"file_path"' } }] })],
    [null, chunk({ tool_calls: [{ index: 0, function: { arguments: ':"a.ts"}' } }] })],
    [null, chunk({}, "tool_calls")],
    [null, chunk({}, null, { prompt_tokens: 100, completion_tokens: 9, total_tokens: 109 })],
    [null, "[DONE]"],
  ]);

  test("assembles tool calls from deltas and reads reasoning_content", async () => {
    const { f, sent } = recorder([{ body: stream }]);
    const p = new CompatibleProvider("lmstudio", { baseUrl: "http://127.0.0.1:1234/v1" }, {}, { fetch: f });
    const events = await collect(p.stream({ ...req([{ kind: "text", role: "user", text: "hi" }]), model: "qwen" }));
    expect(events).toEqual([
      { type: "reasoning_delta", text: "hmm" },
      { type: "text_delta", text: "Let me look." },
      { type: "usage", usage: { input: 100, cachedRead: 0, cacheWrite: 0, output: 9 } },
      { type: "tool_call", id: "call_a", name: "Read", args: { file_path: "a.ts" } },
      { type: "stop", reason: "tool_use" },
    ]);
    expect(sent[0]?.url).toBe("http://127.0.0.1:1234/v1/chat/completions");
    expect(((sent[0] as { body: unknown }).body as { stream_options?: unknown }).stream_options).toEqual({
      include_usage: true,
    });
    expect(p.route).toBe("local");
  });

  test("tool messages, then their images as one user message", () => {
    const msgs = toChatMessages("sys", [
      { kind: "text", role: "user", text: "go" },
      { kind: "text", role: "assistant", text: "a" },
      { kind: "tool_call", id: "1", name: "Read", args: {} },
      {
        kind: "tool_result",
        callId: "1",
        name: "Read",
        content: "r",
        images: [{ mediaType: "image/png", data: "QQ" }],
      },
    ]);
    expect(msgs.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
  });

  test("presets, keys and user-defined servers", () => {
    const missing = (() => {
      try {
        createProvider("openrouter", {});
      } catch (e) {
        return e as ProviderError;
      }
    })();
    expect(missing?.hint).toContain("OPENROUTER_API_KEY");
    expect(createProvider("openrouter", { OPENROUTER_API_KEY: "k" }).route).toBe("api-key");
    expect(createProvider("lmstudio", {}).id).toBe("lmstudio");
    const p = createProvider("mybox", {}, { providers: { mybox: { baseUrl: "http://10.0.0.2:9000/v1" } } });
    expect(p.id).toBe("mybox");
    expect(() => createProvider("nope", {})).toThrow(/unknown provider/);
  });

  test("an unreachable server says so", async () => {
    const f = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const p = new CompatibleProvider("llamacpp", { baseUrl: "http://127.0.0.1:1/v1" }, {}, { fetch: f });
    const err = (await collect(p.stream({ ...req([]), model: "m" })).catch((e) => e)) as ProviderError;
    expect(err.kind).toBe("unavailable");
  });
});

describe("registry and cost", () => {
  test("knows current models and prices them by route", () => {
    const caps = capabilities("anthropic", "claude-sonnet-5-5");
    expect(caps?.context).toBe(1_000_000);
    expect(caps?.cost?.input).toBe(2);
    const usage = { input: 1_000_000, cachedRead: 0, cacheWrite: 0, output: 100_000 };
    expect(costUsd("api-key", caps, usage)).toBeCloseTo(3);
    expect(costUsd("chatgpt-plan", caps, usage)).toBe(0);
    expect(costUsd("local", undefined, usage)).toBe(0);
    expect(costUsd("api-key", undefined, usage)).toBeUndefined();
    // The plan route shares OpenAI's entries.
    expect(capabilities("chatgpt", "gpt-6.1-sol")?.context).toBe(capabilities("openai", "gpt-6.1-sol")?.context);
    expect(routeOf("anthropic")).toBe("api-key");
    expect(routeOf("lmstudio")).toBe("local");
  });

  test("user overrides win", () => {
    const caps = capabilities("anthropic", "claude-sonnet-5-5", {
      "anthropic:claude-sonnet-5-5": { context: 200_000 },
    });
    expect(caps?.context).toBe(200_000);
    expect(caps?.cost?.input).toBe(2);
  });
});

// ADR-0009: teh never reads another app's credentials.
test("engine code never references first-party credential files", () => {
  const roots = ["packages/core/src", "packages/cli/src", "packages/tui/src"].map((r) =>
    join(import.meta.dir, "../../..", r),
  );
  const files = roots.flatMap((r) =>
    readdirSync(r, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith(".ts"))
      .map((d) => join(d.parentPath, d.name)),
  );
  expect(files.length).toBeGreaterThan(20);
  // The sandbox names them only to hide them from commands.
  for (const file of files.filter((f) => !f.endsWith("sandbox.ts"))) {
    const text = readFileSync(file, "utf8");
    expect(text.includes(".credentials.json")).toBe(false);
    expect(/codex\/auth\.json|\.codex/.test(text)).toBe(false);
  }
});
