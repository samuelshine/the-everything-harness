// OpenTelemetry GenAI spans (ADR-0023; synthesis principle 10, [OTH-07]). Off unless the user points
// teh at a collector or a file. Spans carry model names, token counts, tool names, durations
// and outcomes, never prompts, replies, file contents or tool arguments.
//
// One trace per run:
//   invoke_agent teh            gen_ai.operation.name=invoke_agent
//     chat <model>              one per model request; usage and finish reason
//     execute_tool <name>       one per tool call; error.type when it failed
//
// Exporters: OTLP/HTTP with JSON encoding (OTEL_EXPORTER_OTLP_ENDPOINT or
// OTEL_EXPORTER_OTLP_TRACES_ENDPOINT, headers from OTEL_EXPORTER_OTLP_HEADERS), and a JSONL file
// (TEH_TRACE_FILE) that the eval runner reads. No dependencies: the OTLP JSON shape is small.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { VERSION } from "./version";

export type AttrValue = string | number | boolean | string[];
export type Attrs = Record<string, AttrValue | undefined>;

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: "internal" | "client";
  startMs: number;
  endMs: number;
  attributes: Record<string, AttrValue>;
  status: "ok" | "error";
  statusMessage?: string;
};

export interface Span {
  readonly traceId: string;
  readonly spanId: string;
  set(attrs: Attrs): void;
  end(error?: string): void;
}

export interface Tracer {
  start(name: string, attrs?: Attrs, parent?: Span, kind?: SpanRecord["kind"]): Span;
  // Sends what has ended. Called at the end of a run; never throws.
  flush(): Promise<void>;
}

export type Exporter = (spans: SpanRecord[]) => Promise<void> | void;

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

export class RecordingTracer implements Tracer {
  readonly ended: SpanRecord[] = [];
  private pending: SpanRecord[] = [];

  constructor(private readonly exporters: Exporter[] = []) {}

  start(name: string, attrs: Attrs = {}, parent?: Span, kind: SpanRecord["kind"] = "internal"): Span {
    const rec: SpanRecord = {
      traceId: parent?.traceId ?? hex(16),
      spanId: hex(8),
      ...(parent ? { parentSpanId: parent.spanId } : {}),
      name,
      kind,
      startMs: Date.now(),
      endMs: 0,
      attributes: {},
      status: "ok",
    };
    const set = (a: Attrs) => {
      for (const [k, v] of Object.entries(a)) if (v !== undefined) rec.attributes[k] = v;
    };
    set(attrs);
    let done = false;
    return {
      traceId: rec.traceId,
      spanId: rec.spanId,
      set,
      end: (error?: string) => {
        if (done) return;
        done = true;
        rec.endMs = Date.now();
        if (error) {
          rec.status = "error";
          rec.statusMessage = error;
        }
        this.ended.push(rec);
        this.pending.push(rec);
      },
    };
  }

  async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = [];
    if (!batch.length) return;
    // An exporter may throw synchronously or reject; neither reaches the run.
    await Promise.all(this.exporters.map(async (e) => e(batch)).map((p) => p.catch(() => {})));
  }
}

export const NOOP_TRACER: Tracer = {
  start: () => ({ traceId: "", spanId: "", set: () => {}, end: () => {} }),
  flush: async () => {},
};

// --- Exporters ---------------------------------------------------------------------------

export function fileExporter(path: string): Exporter {
  return (spans) => {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${spans.map((s) => JSON.stringify(s)).join("\n")}\n`);
  };
}

const anyValue = (v: AttrValue) =>
  Array.isArray(v)
    ? { arrayValue: { values: v.map((x) => ({ stringValue: x })) } }
    : typeof v === "string"
      ? { stringValue: v }
      : typeof v === "boolean"
        ? { boolValue: v }
        : Number.isInteger(v)
          ? { intValue: String(v) }
          : { doubleValue: v };

const toAttributes = (a: Record<string, AttrValue>) =>
  Object.entries(a).map(([key, v]) => ({ key, value: anyValue(v) }));

// The OTLP/HTTP JSON body for a batch of spans.
export function otlpBody(spans: SpanRecord[], resource: Record<string, AttrValue> = {}) {
  return {
    resourceSpans: [
      {
        resource: {
          attributes: toAttributes({ "service.name": "teh", "service.version": VERSION, ...resource }),
        },
        scopeSpans: [
          {
            scope: { name: "teh", version: VERSION },
            spans: spans.map((s) => ({
              traceId: s.traceId,
              spanId: s.spanId,
              ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
              name: s.name,
              kind: s.kind === "client" ? 3 : 1,
              startTimeUnixNano: `${s.startMs}000000`,
              endTimeUnixNano: `${s.endMs}000000`,
              attributes: toAttributes(s.attributes),
              status: s.status === "error" ? { code: 2, message: s.statusMessage ?? "" } : { code: 1 },
            })),
          },
        ],
      },
    ],
  };
}

export function otlpExporter(
  endpoint: string,
  headers: Record<string, string> = {},
  f: typeof fetch = fetch,
): Exporter {
  return async (spans) => {
    await f(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(otlpBody(spans)),
      signal: AbortSignal.timeout(5000),
    });
  };
}

// "k1=v1,k2=v2" as in the OpenTelemetry environment spec.
export function parseOtlpHeaders(s: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (s ?? "").split(",")) {
    const i = part.indexOf("=");
    if (i > 0) out[decodeURIComponent(part.slice(0, i).trim())] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

// The tracer the environment asks for, or none.
export function tracerFromEnv(env: Record<string, string | undefined>): Tracer | undefined {
  const exporters: Exporter[] = [];
  if (env.TEH_TRACE_FILE) exporters.push(fileExporter(env.TEH_TRACE_FILE));
  const traces = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  if (env.OTEL_SDK_DISABLED !== "true" && (traces || base)) {
    const endpoint = traces ?? `${(base as string).replace(/\/+$/, "")}/v1/traces`;
    exporters.push(otlpExporter(endpoint, parseOtlpHeaders(env.OTEL_EXPORTER_OTLP_HEADERS)));
  }
  return exporters.length ? new RecordingTracer(exporters) : undefined;
}
