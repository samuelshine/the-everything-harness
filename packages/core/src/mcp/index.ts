// MCP servers as teh tools (ADR-0017). Each server tool becomes "mcp__<server>__<tool>",
// Claude Code's naming, so permission rules and hook matchers written for it work here.
import { obj, type Tool, truncate } from "../tools/tool";
import { HttpTransport, McpClient, type McpToolDef, renderMcpResult, StdioTransport } from "./client";
import type { McpServerConfig } from "./config";

export * from "./client";
export * from "./config";

// Tool names must fit provider limits (64 characters, [A-Za-z0-9_-]).
export function mcpToolName(server: string, tool: string): string {
  const clean = tool.replace(/[^A-Za-z0-9_-]/g, "_");
  return `mcp__${server}__${clean}`.slice(0, 64);
}

const MAX_DESCRIPTION = 2000;

export function mcpTool(server: string, client: McpClient, def: McpToolDef): Tool<Record<string, unknown>> {
  const name = mcpToolName(server, def.name);
  const label = def.annotations?.title ?? def.title ?? def.name;
  const description = (def.description ?? label).trim();
  return {
    spec: {
      name,
      description: description.length > MAX_DESCRIPTION ? `${description.slice(0, MAX_DESCRIPTION)}…` : description,
      inputSchema: def.inputSchema && typeof def.inputSchema === "object" ? def.inputSchema : { type: "object" },
    },
    parse: (raw) => obj(raw ?? {}),
    access: (args) => {
      const shown = JSON.stringify(args);
      return {
        kind: "external",
        server,
        summary: `${server}: ${label}${shown && shown !== "{}" ? ` ${shown.length > 80 ? `${shown.slice(0, 79)}…` : shown}` : ""}`,
      };
    },
    run: async (args, ctx) => {
      const r = await client.callTool(def.name, args, ctx.signal);
      return { content: truncate(renderMcpResult(r)), isError: r.isError === true };
    },
  };
}

export type McpServerStatus = {
  name: string;
  scope: McpServerConfig["scope"];
  transport: McpServerConfig["transport"];
  ok: boolean;
  error?: string;
  tools: string[];
  serverInfo?: { name?: string; version?: string };
};

export type McpConnection = {
  tools: Tool[];
  servers: McpServerStatus[];
  // Server-provided usage notes, for the system prompt.
  instructions: { server: string; text: string }[];
  close: () => Promise<void>;
};

// Connect to every server in parallel. A server that fails is reported and skipped.
export async function connectMcp(
  servers: McpServerConfig[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs?: number;
    clientVersion?: string;
    fetch?: typeof fetch;
  },
): Promise<McpConnection> {
  const clients: McpClient[] = [];
  const results = await Promise.all(
    servers.map(async (s): Promise<{ status: McpServerStatus; tools: Tool[]; instructions?: string }> => {
      const transport =
        s.transport === "stdio" ? new StdioTransport(s, opts.cwd, opts.env) : new HttpTransport(s, opts.fetch);
      const client = new McpClient(s.name, transport, opts.clientVersion);
      clients.push(client);
      const base = { name: s.name, scope: s.scope, transport: s.transport };
      try {
        await client.connect(opts.timeoutMs);
        const defs = await client.listTools(opts.timeoutMs);
        const tools = defs.map((d) => mcpTool(s.name, client, d));
        return {
          status: { ...base, ok: true, tools: tools.map((t) => t.spec.name), serverInfo: client.serverInfo },
          tools,
          ...(client.instructions ? { instructions: client.instructions } : {}),
        };
      } catch (e) {
        await client.close().catch(() => {});
        return { status: { ...base, ok: false, error: (e as Error).message, tools: [] }, tools: [] };
      }
    }),
  );
  // Two servers can produce the same truncated name; the first one keeps it.
  const seen = new Set<string>();
  const tools = results.flatMap((r) =>
    r.tools.filter((t) => {
      if (seen.has(t.spec.name)) return false;
      seen.add(t.spec.name);
      return true;
    }),
  );
  return {
    tools,
    servers: results.map((r) => r.status),
    instructions: results.flatMap((r, i) =>
      r.instructions ? [{ server: (servers[i] as McpServerConfig).name, text: r.instructions }] : [],
    ),
    close: async () => {
      await Promise.all(clients.map((c) => c.close().catch(() => {})));
    },
  };
}
