import { afterEach, describe, expect, test } from "bun:test";
import { OllamaProvider, ollamaBaseUrl, toOllamaMessages } from "../src/providers/ollama";
import type { ModelRequest, StreamEvent } from "../src/types";
import { ProviderError } from "../src/types";

type Handler = (req: Request, body: Record<string, unknown>) => Response | Promise<Response>;
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

// A stand-in for the Ollama HTTP API.
function fakeOllama(routes: Record<string, Handler>) {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const path = new URL(req.url).pathname;
      const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : {};
      seen.push({ path, body });
      const route = routes[path];
      return route ? route(req, body) : new Response("not found", { status: 404 });
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

const show =
  (contextLength: number, capabilities = ["completion", "tools"]) =>
  () =>
    Response.json({ capabilities, model_info: { "qwen2.context_length": contextLength } });

const ndjson = (...lines: object[]) => new Response(`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);

const request = (over: Partial<ModelRequest> = {}): ModelRequest => ({
  model: "qwen",
  system: "sys",
  items: [{ kind: "text", role: "user", text: "hi" }],
  tools: [{ name: "Read", description: "read", inputSchema: { type: "object" } }],
  ...over,
});

async function collect(it: AsyncIterable<StreamEvent>) {
  const out: StreamEvent[] = [];
  for await (const e of it) out.push(e);
  return out;
}

describe("OllamaProvider", () => {
  test("streams text and tool calls, sets num_ctx capped at the model maximum", async () => {
    const { url, seen } = fakeOllama({
      "/api/show": show(32_768),
      "/api/chat": () =>
        ndjson(
          { message: { role: "assistant", content: "Let me " } },
          { message: { role: "assistant", content: "look." } },
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ function: { name: "Read", arguments: { file_path: "a.ts" } } }],
            },
          },
          { done: true, done_reason: "stop", prompt_eval_count: 120, eval_count: 30 },
        ),
    });
    const events = await collect(new OllamaProvider({ baseUrl: url, numCtx: 65_536 }).stream(request()));
    expect(events).toEqual([
      { type: "text_delta", text: "Let me " },
      { type: "text_delta", text: "look." },
      { type: "tool_call", id: "ollama_call_1", name: "Read", args: { file_path: "a.ts" } },
      { type: "usage", usage: { input: 120, cachedRead: 0, cacheWrite: 0, output: 30 } },
      { type: "stop", reason: "tool_use" },
    ]);
    const chat = seen.find((s) => s.path === "/api/chat")?.body;
    expect(chat?.options).toEqual({ num_ctx: 32_768 });
    expect(chat?.stream).toBe(true);
    expect(chat?.tools).toEqual([
      { type: "function", function: { name: "Read", description: "read", parameters: { type: "object" } } },
    ]);
  });

  test("refuses a request that cannot fit the window instead of letting Ollama truncate it", async () => {
    const { url, seen } = fakeOllama({ "/api/show": show(4096) });
    const big = request({ system: "x".repeat(20_000) });
    const err = await collect(new OllamaProvider({ baseUrl: url }).stream(big)).catch((e) => e);
    expect(err).toBeInstanceOf(ProviderError);
    expect(err).toMatchObject({ kind: "context_exceeded" });
    expect(err.hint).toContain("TEH_OLLAMA_NUM_CTX");
    expect(seen.some((s) => s.path === "/api/chat")).toBe(false);
  });

  test("probe reports tool support and small windows", async () => {
    const { url } = fakeOllama({ "/api/show": show(8192, ["completion"]) });
    const probe = await new OllamaProvider({ baseUrl: url }).probe("tiny");
    expect(probe.supportsTools).toBe(false);
    expect(probe.contextWindow).toBe(8192);
    expect(probe.notes.join(" ")).toContain("tool calling");
    expect(probe.notes.join(" ")).toContain("8192-token window");
  });

  test("a missing model suggests ollama pull", async () => {
    const { url } = fakeOllama({});
    const err = await new OllamaProvider({ baseUrl: url }).probe("nope:7b").catch((e) => e);
    expect(err).toMatchObject({ kind: "bad_request", hint: "run `ollama pull nope:7b`" });
  });

  test("an unreachable server explains how to start Ollama", async () => {
    const err = await new OllamaProvider({ baseUrl: "http://127.0.0.1:9" }).listModels().catch((e) => e);
    expect(err).toMatchObject({ kind: "unavailable" });
    expect(err.hint).toContain("ollama serve");
  });
});

describe("toOllamaMessages", () => {
  test("groups assistant text and tool calls; tool results carry the tool name", () => {
    expect(
      toOllamaMessages("sys", [
        { kind: "text", role: "user", text: "fix it" },
        { kind: "reasoning", provider: "ollama", text: "thinking..." },
        { kind: "text", role: "assistant", text: "Reading." },
        { kind: "tool_call", id: "1", name: "Read", args: { file_path: "a" } },
        { kind: "tool_result", callId: "1", name: "Read", content: "x" },
        { kind: "reasoning", provider: "anthropic", opaque: { sig: "abc" } },
        { kind: "text", role: "assistant", text: "Done." },
      ]),
    ).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "fix it" },
      {
        role: "assistant",
        content: "Reading.",
        thinking: "thinking...",
        tool_calls: [{ function: { name: "Read", arguments: { file_path: "a" } } }],
      },
      { role: "tool", content: "x", tool_name: "Read" },
      { role: "assistant", content: "Done." },
    ]);
  });
});

describe("ollamaBaseUrl", () => {
  test("follows OLLAMA_HOST conventions", () => {
    expect(ollamaBaseUrl({})).toBe("http://127.0.0.1:11434");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "0.0.0.0:1234" })).toBe("http://0.0.0.0:1234");
    expect(ollamaBaseUrl({ OLLAMA_HOST: "https://gpu.box/" })).toBe("https://gpu.box");
  });
});
