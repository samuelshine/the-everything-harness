import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent";
import { readLedger, recordUsage, summarise } from "../src/ledger";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { builtinTools } from "../src/tools";
import {
  fileExporter,
  otlpBody,
  otlpExporter,
  parseOtlpHeaders,
  RecordingTracer,
  type SpanRecord,
  tracerFromEnv,
} from "../src/tracing";
import { tempDir } from "./helpers";

describe("tracing", () => {
  test("a run produces invoke_agent > chat and execute_tool spans with GenAI attributes and no content", async () => {
    const tracer = new RecordingTracer();
    const cwd = tempDir();
    await runAgent({
      provider: new FakeProvider([callTool("Read", { file_path: "missing.txt" }), say("secret reply text")]),
      model: "fake-model",
      prompt: "secret prompt text",
      cwd,
      tools: builtinTools,
      permissions: { mode: "default", allow: [], deny: [] },
      ask: async () => false,
      tracer,
    });
    const spans = tracer.ended;
    const root = spans.find((s) => s.name === "invoke_agent teh") as SpanRecord;
    expect(root.attributes).toMatchObject({
      "gen_ai.operation.name": "invoke_agent",
      "gen_ai.request.model": "fake-model",
      "gen_ai.usage.output_tokens": 5,
      "teh.stop_reason": "end",
      "teh.auth_route": "local",
    });
    const chats = spans.filter((s) => s.attributes["gen_ai.operation.name"] === "chat");
    expect(chats).toHaveLength(2);
    expect(chats.every((c) => c.parentSpanId === root.spanId && c.traceId === root.traceId)).toBe(true);
    expect(chats[1]?.attributes["gen_ai.response.finish_reasons"]).toEqual(["end"]);
    const tool = spans.find((s) => s.name === "execute_tool Read") as SpanRecord;
    expect(tool.attributes["gen_ai.tool.name"]).toBe("Read");
    expect(tool.status).toBe("error");
    expect(JSON.stringify(spans)).not.toContain("secret");
  });

  test("OTLP JSON body and exporter", async () => {
    const tracer = new RecordingTracer();
    const s = tracer.start("chat m", { "gen_ai.usage.input_tokens": 12, ratio: 0.5, ok: true, list: ["a"] });
    s.end("boom");
    const body = otlpBody(tracer.ended);
    const span = body.resourceSpans[0]?.scopeSpans[0]?.spans[0];
    expect(span?.status).toEqual({ code: 2, message: "boom" });
    expect(span?.attributes).toContainEqual({ key: "gen_ai.usage.input_tokens", value: { intValue: "12" } });
    expect(span?.attributes).toContainEqual({ key: "ratio", value: { doubleValue: 0.5 } });
    expect(span?.startTimeUnixNano).toMatch(/^\d+000000$/);

    const sent: { url: string; body: string; headers: Record<string, string> }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      sent.push({ url, body: init.body as string, headers: init.headers as Record<string, string> });
      return new Response("{}");
    }) as unknown as typeof fetch;
    const t2 = new RecordingTracer([otlpExporter("http://c/v1/traces", { authorization: "x" }, f)]);
    t2.start("a").end();
    await t2.flush();
    await t2.flush(); // nothing new: no second request
    expect(sent).toHaveLength(1);
    expect(sent[0]?.headers.authorization).toBe("x");
    expect(JSON.parse(sent[0]?.body ?? "{}").resourceSpans[0].resource.attributes[0]).toEqual({
      key: "service.name",
      value: { stringValue: "teh" },
    });
  });

  test("exporter failures never reach the run", async () => {
    const t = new RecordingTracer([
      () => {
        throw new Error("collector down");
      },
    ]);
    t.start("a").end();
    await t.flush();
  });

  test("environment configuration", async () => {
    expect(tracerFromEnv({})).toBeUndefined();
    expect(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x", OTEL_SDK_DISABLED: "true" })).toBeUndefined();
    expect(tracerFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://x" })).toBeDefined();
    expect(parseOtlpHeaders("a=1, b%20c=x%3Dy")).toEqual({ a: "1", "b c": "x=y" });
    const file = join(tempDir(), "t", "trace.jsonl");
    const t = tracerFromEnv({ TEH_TRACE_FILE: file }) as RecordingTracer;
    t.start("one").end();
    await t.flush();
    await new RecordingTracer([fileExporter(file)]).flush();
    expect(readFileSync(file, "utf8").trim().split("\n")).toHaveLength(1);
  });
});

describe("cost ledger", () => {
  test("records priced and local runs and sums them", () => {
    const home = tempDir("teh-home-");
    const usage = { input: 1_000_000, cachedRead: 0, cacheWrite: 0, output: 0 };
    const paid = recordUsage(home, {
      session: "s1",
      cwd: "/work/proj",
      provider: "anthropic",
      model: "claude-haiku-4-5",
      route: "api-key",
      usage,
    });
    expect(paid?.costUsd).toBeGreaterThan(0);
    expect(paid?.project).toBe("proj");
    recordUsage(home, { session: "s2", cwd: "/w", provider: "ollama", model: "q", route: "local", usage });
    recordUsage(home, {
      session: "s3",
      cwd: "/w",
      provider: "openai",
      model: "no-such-model",
      route: "api-key",
      usage,
    });
    expect(
      recordUsage(home, {
        session: "s4",
        cwd: "/w",
        provider: "ollama",
        model: "q",
        route: "local",
        usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 },
      }),
    ).toBeUndefined();
    const entries = readLedger(home);
    expect(entries).toHaveLength(3);
    const rows = summarise(entries, (e) => e.route);
    const api = rows.find((r) => r.key === "api-key");
    expect(api?.runs).toBe(2);
    expect(api?.unpriced).toBe(1);
    expect(api?.costUsd).toBeCloseTo(paid?.costUsd ?? 0);
    expect(rows.find((r) => r.key === "local")?.costUsd).toBe(0);
  });
});
