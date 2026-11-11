// A tiny MCP server for tests. Over stdio by default; `handle` is reused for the HTTP tests.
// Tools: echo (two pages of tools/list), fail (isError), slow (never answers), touch (writes a file).
import { writeFileSync } from "node:fs";

type Msg = { jsonrpc: "2.0"; id?: number | string; method?: string; params?: Record<string, unknown> };

const TOOLS_PAGE_1 = [
  {
    name: "echo",
    title: "Echo",
    description: "Echo the text back.",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    annotations: { readOnlyHint: true },
  },
  { name: "fail", description: "Always fails.", inputSchema: { type: "object" } },
];
const TOOLS_PAGE_2 = [
  { name: "slow", description: "Never answers.", inputSchema: { type: "object" } },
  {
    name: "touch",
    description: "Create a file.",
    inputSchema: { type: "object", properties: { path: { type: "string" } } },
  },
];

export function handle(m: Msg): unknown | undefined {
  if (m.id === undefined) return undefined;
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: m.id, result });
  switch (m.method) {
    case "initialize":
      return ok({
        protocolVersion: "2025-06-18",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "test-server", version: "1.2.3" },
        instructions: "Use echo to repeat text.",
      });
    case "tools/list":
      return ok(m.params?.cursor === "p2" ? { tools: TOOLS_PAGE_2 } : { tools: TOOLS_PAGE_1, nextCursor: "p2" });
    case "tools/call": {
      const args = (m.params?.arguments ?? {}) as Record<string, string>;
      if (m.params?.name === "echo")
        return ok({
          content: [
            { type: "text", text: `echo: ${args.text}` },
            { type: "image", mimeType: "image/png", data: "" },
          ],
        });
      if (m.params?.name === "fail") return ok({ content: [{ type: "text", text: "it broke" }], isError: true });
      if (m.params?.name === "slow") return undefined;
      if (m.params?.name === "touch") {
        writeFileSync(String(args.path), "touched");
        return ok({ structuredContent: { created: args.path } });
      }
      return { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: `unknown tool ${m.params?.name}` } };
    }
    default:
      return { jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "method not found" } };
  }
}

if (import.meta.main) {
  console.error("test server starting");
  const decoder = new TextDecoder();
  let buf = "";
  let pinged = false;
  for await (const chunk of Bun.stdin.stream()) {
    buf += decoder.decode(chunk, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Msg;
      // Exercise server-to-client requests once the session is up.
      if (m.method === "notifications/initialized" && !pinged) {
        pinged = true;
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: "srv-1", method: "ping" })}\n`);
        process.stdout.write("this line is a stray log, not JSON\n");
      }
      if (m.id === "srv-1") {
        // The client's answer to our ping: record it via stderr.
        console.error(`ping answered: ${JSON.stringify(m)}`);
        continue;
      }
      const reply = handle(m);
      if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }
}
