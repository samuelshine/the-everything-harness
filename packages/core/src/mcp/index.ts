// MCP servers as teh tools (ADR-0017, ADR-0025). Each server tool becomes "mcp__<server>__<tool>",
// Claude Code's naming, so permission rules and hook matchers written for it work here.
import { createHash } from "node:crypto";
import type { Sandbox } from "../sandbox";
import { obj, str, type Tool, truncate } from "../tools/tool";
import {
  HttpTransport,
  McpClient,
  type McpPromptDef,
  type McpResource,
  type McpToolDef,
  mcpImages,
  renderMcpResult,
  StdioTransport,
} from "./client";
import type { McpServerConfig } from "./config";

export * from "./client";
export * from "./config";
export * from "./oauth";

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
      const images = ctx.vision ? mcpImages(r) : [];
      return {
        content: truncate(renderMcpResult(r, images.length > 0)),
        isError: r.isError === true,
        ...(images.length ? { images } : {}),
      };
    },
  };
}

// A fingerprint of a server's tool definitions, to notice when they change ("rug pull").
export function toolsHash(defs: McpToolDef[]): string {
  const canon = [...defs]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((d) => ({ name: d.name, description: d.description ?? "", inputSchema: d.inputSchema ?? {} }));
  return createHash("sha256").update(JSON.stringify(canon)).digest("hex").slice(0, 16);
}

export type McpServerStatus = {
  name: string;
  scope: McpServerConfig["scope"];
  transport: McpServerConfig["transport"];
  ok: boolean;
  error?: string;
  // The server answered 401: `teh mcp login <name>` can sign in.
  needsAuth?: boolean;
  tools: string[];
  resources: number;
  prompts: string[];
  serverInfo?: { name?: string; version?: string };
  // Tool definitions against the pinned fingerprint: first seen, unchanged, or changed.
  pin?: "new" | "same" | "changed";
  toolsHash?: string;
  sandboxed?: boolean;
};

export type McpPrompt = { server: string; def: McpPromptDef; name: string; client: McpClient };

export type McpConnection = {
  tools: Tool[];
  servers: McpServerStatus[];
  // Server-provided usage notes, for the system prompt.
  instructions: { server: string; text: string }[];
  // Prompts, offered as /mcp__<server>__<prompt> commands.
  prompts: McpPrompt[];
  // Tools for listing and reading resources, when any server has them.
  resourceTools: Tool[];
  // Re-list the tools of servers that sent tools/list_changed; true when anything changed.
  refresh: () => Promise<boolean>;
  close: () => Promise<void>;
};

export type PinStore = { get(key: string): string | undefined; set(key: string, hash: string): void };

// Connect to every server in parallel. A server that fails is reported and skipped.
export async function connectMcp(
  servers: McpServerConfig[],
  opts: {
    cwd: string;
    env: Record<string, string | undefined>;
    timeoutMs?: number;
    clientVersion?: string;
    fetch?: typeof fetch;
    // OS sandbox for servers configured with "sandbox": true.
    sandbox?: Sandbox;
    // OAuth access tokens for HTTP servers the user has signed in to.
    token?: (server: McpServerConfig) => Promise<string | undefined>;
    pins?: PinStore;
  },
): Promise<McpConnection> {
  const clients = new Map<string, McpClient>();
  const toolsBy = new Map<string, Tool[]>();
  const results = await Promise.all(
    servers.map(async (s) => {
      const sandboxed = s.transport === "stdio" && s.sandbox === true && opts.sandbox !== undefined;
      const transport =
        s.transport === "stdio"
          ? new StdioTransport(s, opts.cwd, opts.env, sandboxed ? opts.sandbox : undefined)
          : new HttpTransport(
              s,
              opts.fetch,
              opts.token ? () => (opts.token as NonNullable<typeof opts.token>)(s) : undefined,
            );
      const client = new McpClient(s.name, transport, opts.clientVersion, [opts.cwd]);
      clients.set(s.name, client);
      const base = { name: s.name, scope: s.scope, transport: s.transport, resources: 0, prompts: [] as string[] };
      try {
        await client.connect(opts.timeoutMs);
        const defs = await client.listTools(opts.timeoutMs);
        const [resources, prompts] = await Promise.all([
          client.listResources(opts.timeoutMs).catch(() => [] as McpResource[]),
          client.listPrompts(opts.timeoutMs).catch(() => [] as McpPromptDef[]),
        ]);
        const tools = defs.map((d) => mcpTool(s.name, client, d));
        toolsBy.set(s.name, tools);
        const hash = toolsHash(defs);
        const key = `${s.scope}:${s.name}`;
        const pinned = opts.pins?.get(key);
        if (opts.pins && !pinned) opts.pins.set(key, hash);
        const status: McpServerStatus = {
          ...base,
          ok: true,
          tools: tools.map((t) => t.spec.name),
          resources: resources.length,
          prompts: prompts.map((p) => p.name),
          serverInfo: client.serverInfo,
          toolsHash: hash,
          ...(opts.pins
            ? { pin: !pinned ? ("new" as const) : pinned === hash ? ("same" as const) : ("changed" as const) }
            : {}),
          ...(sandboxed ? { sandboxed: true } : {}),
        };
        return {
          status,
          prompts: prompts.map((def) => ({ server: s.name, def, name: mcpToolName(s.name, def.name), client })),
          ...(client.instructions ? { instructions: client.instructions } : {}),
        };
      } catch (e) {
        await client.close().catch(() => {});
        const needsAuth = transport instanceof HttpTransport && transport.authChallenge !== undefined;
        return {
          status: { ...base, ok: false, error: (e as Error).message, tools: [], ...(needsAuth ? { needsAuth } : {}) },
          prompts: [] as McpPrompt[],
        };
      }
    }),
  );
  const conn: McpConnection = {
    tools: [],
    servers: results.map((r) => r.status),
    instructions: results.flatMap((r, i) =>
      r.instructions ? [{ server: (servers[i] as McpServerConfig).name, text: r.instructions }] : [],
    ),
    prompts: results.flatMap((r) => r.prompts),
    resourceTools: [],
    refresh: async () => {
      let changed = false;
      for (const [name, client] of clients) {
        if (!client.toolsChanged) continue;
        try {
          const defs = await client.listTools(opts.timeoutMs);
          toolsBy.set(
            name,
            defs.map((d) => mcpTool(name, client, d)),
          );
          const status = conn.servers.find((x) => x.name === name);
          if (status) {
            status.tools = (toolsBy.get(name) ?? []).map((t) => t.spec.name);
            status.toolsHash = toolsHash(defs);
            const pinned = opts.pins?.get(`${status.scope}:${name}`);
            if (pinned) status.pin = pinned === status.toolsHash ? "same" : "changed";
          }
          changed = true;
        } catch {
          // Keep the old list; the server may be restarting.
        }
      }
      if (changed) conn.tools = dedupe(servers.flatMap((s) => toolsBy.get(s.name) ?? []));
      return changed;
    },
    close: async () => {
      await Promise.all([...clients.values()].map((c) => c.close().catch(() => {})));
    },
  };
  conn.tools = dedupe(servers.flatMap((s) => toolsBy.get(s.name) ?? []));
  const withResources = conn.servers.filter((x) => x.ok && x.resources > 0).map((x) => x.name);
  if (withResources.length) conn.resourceTools = resourceTools(clients, withResources);
  return conn;
}

// Two servers can produce the same truncated name; the first one keeps it.
function dedupe(tools: Tool[]): Tool[] {
  const seen = new Set<string>();
  return tools.filter((t) => {
    if (seen.has(t.spec.name)) return false;
    seen.add(t.spec.name);
    return true;
  });
}

// ListMcpResourcesTool and ReadMcpResourceTool, Claude Code's names, so rules written for it work.
function resourceTools(clients: Map<string, McpClient>, servers: string[]): Tool[] {
  const client = (name: string) => {
    const c = clients.get(name);
    if (!c || !servers.includes(name))
      throw new Error(`no MCP server "${name}" with resources; servers: ${servers.join(", ")}`);
    return c;
  };
  const list: Tool<{ server?: string }> = {
    spec: {
      name: "ListMcpResourcesTool",
      description: `List resources (files, records, documents) that MCP servers offer. Servers with resources: ${servers.join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: { server: { type: "string", description: "Only this server's resources" } },
      },
    },
    parse: (raw) => {
      const o = obj(raw ?? {});
      return o.server === undefined ? {} : { server: str(o, "server") };
    },
    access: (a) => ({
      kind: "external",
      server: a.server ?? servers.join(","),
      summary: `list MCP resources${a.server ? ` from ${a.server}` : ""}`,
    }),
    run: async (a) => {
      const lines: string[] = [];
      for (const name of a.server ? [a.server] : servers) {
        const rs = await client(name).listResources();
        lines.push(
          `${name}:`,
          ...rs.map((r) => `  ${r.uri}${r.name ? `  ${r.name}` : ""}${r.description ? ` — ${r.description}` : ""}`),
        );
      }
      return { content: truncate(lines.join("\n") || "(no resources)") };
    },
  };
  const read: Tool<{ server: string; uri: string }> = {
    spec: {
      name: "ReadMcpResourceTool",
      description: "Read one resource from an MCP server by its URI (from ListMcpResourcesTool).",
      inputSchema: {
        type: "object",
        properties: { server: { type: "string" }, uri: { type: "string" } },
        required: ["server", "uri"],
      },
    },
    parse: (raw) => {
      const o = obj(raw);
      return { server: str(o, "server"), uri: str(o, "uri") };
    },
    access: (a) => ({ kind: "external", server: a.server, summary: `read ${a.uri} from ${a.server}` }),
    run: async (a, ctx) => {
      const contents = await client(a.server).readResource(a.uri, ctx.signal);
      const images = contents.flatMap((c) =>
        ctx.vision && c.blob && /^image\/(png|jpeg|gif|webp)$/.test(c.mimeType ?? "")
          ? [{ mediaType: c.mimeType as string, data: c.blob }]
          : [],
      );
      const text = contents
        .map((c) =>
          c.text !== undefined
            ? c.text
            : `[${c.mimeType ?? "binary"} ${c.uri}${c.blob ? `, ${Math.round((c.blob.length * 3) / 4)} bytes` : ""}]`,
        )
        .join("\n\n");
      return { content: truncate(text || "(empty)"), ...(images.length ? { images } : {}) };
    },
  };
  return [list as Tool, read as Tool];
}

// The text of an MCP prompt, for use as the user's prompt. Arguments are given in order.
export async function expandMcpPrompt(p: McpPrompt, args: string): Promise<string> {
  const declared = p.def.arguments ?? [];
  const words = args.trim() ? args.trim().split(/\s+/) : [];
  const values: Record<string, string> = {};
  declared.forEach((a, i) => {
    // The last argument takes the rest of the line.
    const v = i === declared.length - 1 ? words.slice(i).join(" ") : words[i];
    if (v) values[a.name] = v;
  });
  const missing = declared.filter((a) => a.required && !values[a.name]).map((a) => a.name);
  if (missing.length)
    throw new Error(
      `/${p.name} needs ${missing.join(", ")}: /${p.name} ${declared.map((a) => `<${a.name}>`).join(" ")}`,
    );
  const messages = await p.client.getPrompt(p.def.name, values);
  return messages
    .map((m) => renderMcpResult({ content: [m.content] }))
    .join("\n\n")
    .trim();
}
