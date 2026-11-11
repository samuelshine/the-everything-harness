// A small MCP client (ADR-0017): JSON-RPC 2.0 over stdio or streamable HTTP, enough for
// initialize, tools/list and tools/call. No SDK dependency; the protocol surface is small.
import type { McpServerConfig } from "./config";

export const MCP_PROTOCOL_VERSION = "2025-11-25";

type Id = number | string;
export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: Id;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

export class McpError extends Error {
  constructor(
    message: string,
    readonly code?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

export interface Transport {
  start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void>;
  send(m: JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
}

// --- stdio: newline-delimited JSON on the server's stdin/stdout ------------------------

export class StdioTransport implements Transport {
  private proc?: ReturnType<typeof Bun.spawn>;
  private stderrTail = "";
  private closed = false;

  constructor(
    private readonly server: Extract<McpServerConfig, { transport: "stdio" }>,
    private readonly cwd: string,
    private readonly env: Record<string, string | undefined>,
  ) {}

  async start(onMessage: (m: JsonRpcMessage) => void, onClose: (why: string) => void): Promise<void> {
    const env = { ...this.env, ...this.server.env };
    const which = Bun.which(this.server.command, { PATH: env.PATH ?? "" }) ?? this.server.command;
    try {
      this.proc = Bun.spawn([which, ...this.server.args], {
        cwd: this.cwd,
        env: env as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      throw new McpError(`could not start \`${this.server.command}\`: ${(e as Error).message}`);
    }
    const proc = this.proc;
    void (async () => {
      const decoder = new TextDecoder();
      let buf = "";
      for await (const chunk of proc.stdout as ReadableStream<Uint8Array>) {
        buf += decoder.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              onMessage(JSON.parse(line) as JsonRpcMessage);
            } catch {
              // Servers sometimes log to stdout; skip what is not JSON-RPC.
            }
          }
          nl = buf.indexOf("\n");
        }
      }
    })();
    void (async () => {
      const decoder = new TextDecoder();
      for await (const chunk of proc.stderr as ReadableStream<Uint8Array>)
        this.stderrTail = (this.stderrTail + decoder.decode(chunk, { stream: true })).slice(-2000);
    })();
    void proc.exited.then((code) => {
      if (this.closed) return;
      const tail = this.stderrTail.trim().split("\n").slice(-3).join("\n");
      onClose(`server exited with code ${code}${tail ? `: ${tail}` : ""}`);
    });
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const sink = this.proc?.stdin as import("bun").FileSink | undefined;
    if (!sink) throw new McpError("server not started");
    sink.write(`${JSON.stringify(m)}\n`);
    await sink.flush();
  }

  async close(): Promise<void> {
    this.closed = true;
    if (!this.proc) return;
    try {
      await (this.proc.stdin as import("bun").FileSink).end();
    } catch {
      // already gone
    }
    const exited = await Promise.race([this.proc.exited.then(() => true), Bun.sleep(1000).then(() => false)]);
    if (!exited) this.proc.kill();
  }
}

// --- Streamable HTTP: POST each message; the reply is JSON or an SSE stream ------------

export class HttpTransport implements Transport {
  private onMessage: (m: JsonRpcMessage) => void = () => {};
  private sessionId: string | undefined;
  private protocolVersion: string | undefined;
  private readonly abort = new AbortController();

  constructor(
    private readonly server: Extract<McpServerConfig, { transport: "http" }>,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async start(onMessage: (m: JsonRpcMessage) => void): Promise<void> {
    this.onMessage = onMessage;
  }

  setProtocolVersion(v: string) {
    this.protocolVersion = v;
  }

  async send(m: JsonRpcMessage): Promise<void> {
    const headers: Record<string, string> = {
      ...this.server.headers,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...(this.protocolVersion ? { "mcp-protocol-version": this.protocolVersion } : {}),
    };
    let res: Response;
    try {
      res = await this.fetchImpl(this.server.url, {
        method: "POST",
        headers,
        body: JSON.stringify(m),
        signal: this.abort.signal,
      });
    } catch (e) {
      throw new McpError(`cannot reach ${this.server.url}: ${(e as Error).message}`);
    }
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300);
      const hint =
        res.status === 401 || res.status === 403
          ? " (the server wants credentials; add an Authorization header in the server's config. OAuth sign-in is not supported yet)"
          : "";
      throw new McpError(`HTTP ${res.status} from ${this.server.url}${hint}${body ? `: ${body}` : ""}`, res.status);
    }
    const type = res.headers.get("content-type") ?? "";
    if (res.status === 202 || !m.id) {
      await res.body?.cancel();
      return;
    }
    if (type.includes("text/event-stream")) {
      await this.readSse(res);
      return;
    }
    const text = await res.text();
    if (!text.trim()) return;
    const parsed = JSON.parse(text) as JsonRpcMessage | JsonRpcMessage[];
    for (const msg of Array.isArray(parsed) ? parsed : [parsed]) this.onMessage(msg);
  }

  private async readSse(res: Response) {
    const decoder = new TextDecoder();
    let buf = "";
    let data: string[] = [];
    const dispatch = () => {
      if (!data.length) return;
      try {
        this.onMessage(JSON.parse(data.join("\n")) as JsonRpcMessage);
      } catch {
        // not JSON-RPC
      }
      data = [];
    };
    for await (const chunk of res.body as ReadableStream<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let nl = buf.indexOf("\n");
      while (nl >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, "");
        buf = buf.slice(nl + 1);
        if (line === "") dispatch();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        nl = buf.indexOf("\n");
      }
    }
    dispatch();
  }

  async close(): Promise<void> {
    if (this.sessionId) {
      await this.fetchImpl(this.server.url, {
        method: "DELETE",
        headers: { ...this.server.headers, "mcp-session-id": this.sessionId },
      }).catch(() => {});
    }
    this.abort.abort();
  }
}

// --- Client ---------------------------------------------------------------------------

export type McpToolDef = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; title?: string };
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; mimeType?: string; data?: string }
  | { type: "audio"; mimeType?: string }
  | { type: "resource"; resource: { uri: string; text?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string }
  | { type: string; [k: string]: unknown };

export type McpCallResult = { content?: McpContent[]; structuredContent?: unknown; isError?: boolean };

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

export class McpClient {
  private nextId = 1;
  private readonly pending = new Map<Id, Pending>();
  private closedWhy: string | undefined;
  serverInfo: { name?: string; version?: string } = {};
  instructions: string | undefined;
  protocolVersion: string | undefined;
  toolsChanged = false;

  constructor(
    readonly name: string,
    private readonly transport: Transport,
    private readonly clientVersion = "0.0.0",
  ) {}

  async connect(timeoutMs = 30_000): Promise<void> {
    await this.transport.start(
      (m) => this.receive(m),
      (why) => this.fail(why),
    );
    const init = (await this.request(
      "initialize",
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "teh", title: "The Everything Harness", version: this.clientVersion },
      },
      timeoutMs,
    )) as { protocolVersion?: string; serverInfo?: { name?: string; version?: string }; instructions?: string };
    this.protocolVersion = init.protocolVersion;
    this.serverInfo = init.serverInfo ?? {};
    this.instructions = init.instructions;
    if (this.transport instanceof HttpTransport && init.protocolVersion)
      this.transport.setProtocolVersion(init.protocolVersion);
    await this.transport.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async listTools(timeoutMs = 30_000): Promise<McpToolDef[]> {
    const tools: McpToolDef[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page++) {
      const r = (await this.request("tools/list", cursor ? { cursor } : {}, timeoutMs)) as {
        tools?: McpToolDef[];
        nextCursor?: string;
      };
      tools.push(...(r.tools ?? []).filter((t) => t && typeof t.name === "string"));
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    this.toolsChanged = false;
    return tools;
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal, timeoutMs = 600_000): Promise<McpCallResult> {
    return (await this.request("tools/call", { name, arguments: args ?? {} }, timeoutMs, signal)) as McpCallResult;
  }

  async close(): Promise<void> {
    this.fail("client closed");
    await this.transport.close();
  }

  private request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.closedWhy) return Promise.reject(new McpError(`${this.name}: ${this.closedWhy}`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        done();
        void this.transport
          .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "timeout" } })
          .catch(() => {});
        reject(new McpError(`${this.name}: ${method} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      const onAbort = () => {
        done();
        void this.transport
          .send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "interrupted" } })
          .catch(() => {});
        reject(new McpError(`${this.name}: ${method} interrupted`));
      };
      signal?.addEventListener("abort", onAbort);
      this.pending.set(id, {
        resolve: (v) => {
          done();
          resolve(v);
        },
        reject: (e) => {
          done();
          reject(e);
        },
      });
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch((e: Error) => this.pending.get(id)?.reject(e));
    });
  }

  private receive(m: JsonRpcMessage) {
    if (m.id !== undefined && m.method === undefined) {
      const p = this.pending.get(m.id);
      if (!p) return;
      if (m.error) p.reject(new McpError(`${this.name}: ${m.error.message}`, m.error.code));
      else p.resolve(m.result ?? {});
      return;
    }
    if (m.method && m.id !== undefined) {
      // Requests from the server. teh offers no client capabilities yet, so only ping is answered.
      const reply: JsonRpcMessage =
        m.method === "ping"
          ? { jsonrpc: "2.0", id: m.id, result: {} }
          : { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: `teh does not support ${m.method}` } };
      void this.transport.send(reply).catch(() => {});
      return;
    }
    if (m.method === "notifications/tools/list_changed") this.toolsChanged = true;
  }

  private fail(why: string) {
    if (this.closedWhy) return;
    this.closedWhy = why;
    for (const p of [...this.pending.values()]) p.reject(new McpError(`${this.name}: ${why}`));
  }
}

// Text the model sees for a tool result. Images and audio are described, not inlined, until
// the item model carries images.
export function renderMcpResult(r: McpCallResult): string {
  const parts: string[] = [];
  for (const c of r.content ?? []) {
    if (c.type === "text") parts.push(String((c as { text: unknown }).text ?? ""));
    else if (c.type === "resource") {
      const res = (c as { resource: { uri: string; text?: string } }).resource;
      parts.push(res.text !== undefined ? `[resource ${res.uri}]\n${res.text}` : `[resource ${res.uri}]`);
    } else if (c.type === "resource_link") parts.push(`[link ${(c as { uri: string }).uri}]`);
    else if (c.type === "image" || c.type === "audio")
      parts.push(
        `[${c.type}${(c as { mimeType?: string }).mimeType ? ` ${(c as { mimeType?: string }).mimeType}` : ""} omitted]`,
      );
  }
  if (!parts.length && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent, null, 2));
  return parts.join("\n") || "(no output)";
}
