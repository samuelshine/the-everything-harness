// MCP server configuration (ADR-0017), in Claude Code's ".mcp.json" format:
//   {"mcpServers": {"name": {"command": "npx", "args": [...], "env": {...}}}}
//   {"mcpServers": {"name": {"type": "http", "url": "https://…", "headers": {...}}}}
// Strings may use ${VAR} and ${VAR:-default}, expanded from the environment.
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export type McpScope = "user" | "project" | "flag";

export type McpServerConfig =
  | {
      name: string;
      scope: McpScope;
      source: string;
      transport: "stdio";
      command: string;
      args: string[];
      env: Record<string, string>;
    }
  | {
      name: string;
      scope: McpScope;
      source: string;
      transport: "http";
      url: string;
      headers: Record<string, string>;
    };

export type McpConfigResult = { servers: McpServerConfig[]; problems: { path: string; message: string }[] };

// Server names become part of tool names (mcp__<server>__<tool>), so keep them simple.
const NAME = /^[A-Za-z0-9_-]+$/;

export function expandEnv(text: string, env: Record<string, string | undefined>): { text: string; missing: string[] } {
  const missing: string[] = [];
  const out = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    missing.push(name);
    return "";
  });
  return { text: out, missing };
}

// Parse one file's (or one --mcp-config value's) "mcpServers" object.
export function parseMcpServers(
  raw: unknown,
  scope: McpScope,
  source: string,
  env: Record<string, string | undefined>,
): McpConfigResult {
  const servers: McpServerConfig[] = [];
  const problems: McpConfigResult["problems"] = [];
  const problem = (message: string) => problems.push({ path: source, message });
  const block = (raw as { mcpServers?: unknown })?.mcpServers;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    problem('expected {"mcpServers": {...}}');
    return { servers, problems };
  }
  for (const [name, value] of Object.entries(block)) {
    if (!NAME.test(name)) {
      problem(`server name "${name}" may only use letters, digits, "_" and "-"`);
      continue;
    }
    const v = value as Record<string, unknown>;
    if (!v || typeof v !== "object") {
      problem(`server "${name}" must be an object`);
      continue;
    }
    const missing: string[] = [];
    const x = (s: string) => {
      const r = expandEnv(s, env);
      missing.push(...r.missing);
      return r.text;
    };
    const strMap = (m: unknown, field: string): Record<string, string> | undefined => {
      if (m === undefined) return {};
      if (!m || typeof m !== "object" || Array.isArray(m) || Object.values(m).some((s) => typeof s !== "string")) {
        problem(`server "${name}": ${field} must map names to strings`);
        return undefined;
      }
      return Object.fromEntries(Object.entries(m as Record<string, string>).map(([k, s]) => [k, x(s)]));
    };
    const type = v.type ?? (v.url ? "http" : "stdio");
    if (type === "stdio") {
      if (typeof v.command !== "string" || !v.command.trim()) {
        problem(`server "${name}" needs a "command"`);
        continue;
      }
      if (v.args !== undefined && (!Array.isArray(v.args) || v.args.some((a) => typeof a !== "string"))) {
        problem(`server "${name}": args must be a list of strings`);
        continue;
      }
      const serverEnv = strMap(v.env, "env");
      if (!serverEnv) continue;
      servers.push({
        name,
        scope,
        source,
        transport: "stdio",
        command: x(v.command),
        args: ((v.args as string[] | undefined) ?? []).map(x),
        env: serverEnv,
      });
    } else if (type === "http" || type === "streamable-http") {
      if (typeof v.url !== "string" || !/^https?:\/\//.test(v.url)) {
        problem(`server "${name}" needs an http(s) "url"`);
        continue;
      }
      const headers = strMap(v.headers, "headers");
      if (!headers) continue;
      servers.push({ name, scope, source, transport: "http", url: x(v.url), headers });
    } else {
      problem(
        type === "sse"
          ? `server "${name}": the old SSE transport is not supported; use the server's streamable HTTP endpoint ("type": "http")`
          : `server "${name}": unknown type "${String(type)}"`,
      );
      continue;
    }
    if (missing.length)
      problem(`server "${name}": environment variable(s) not set: ${[...new Set(missing)].join(", ")}`);
  }
  return { servers, problems };
}

export function mcpConfigFiles(tehHome: string, projectRoot: string): { scope: McpScope; path: string }[] {
  return [
    { scope: "user", path: join(tehHome, "mcp.json") },
    { scope: "project", path: join(projectRoot, ".mcp.json") },
  ];
}

// User servers, then project servers, then --mcp-config (a file path or inline JSON).
// On a name clash the later one wins, as with Claude Code's scopes; flags beat files.
export function loadMcpConfig(opts: {
  tehHome: string;
  projectRoot: string;
  cwd: string;
  env: Record<string, string | undefined>;
  flags?: string[];
}): McpConfigResult {
  const all: McpConfigResult = { servers: [], problems: [] };
  const add = (raw: unknown, scope: McpScope, source: string) => {
    const r = parseMcpServers(raw, scope, source, opts.env);
    all.problems.push(...r.problems);
    for (const s of r.servers) {
      all.servers = all.servers.filter((o) => o.name !== s.name);
      all.servers.push(s);
    }
  };
  const readJson = (path: string, scope: McpScope) => {
    try {
      add(JSON.parse(readFileSync(path, "utf8")), scope, path);
    } catch (e) {
      all.problems.push({ path, message: `not valid JSON: ${(e as Error).message}` });
    }
  };
  for (const f of mcpConfigFiles(opts.tehHome, opts.projectRoot)) if (existsSync(f.path)) readJson(f.path, f.scope);
  for (const flag of opts.flags ?? []) {
    const t = flag.trim();
    if (t.startsWith("{")) {
      try {
        add(JSON.parse(t), "flag", "--mcp-config");
      } catch (e) {
        all.problems.push({ path: "--mcp-config", message: `not valid JSON: ${(e as Error).message}` });
      }
    } else {
      const path = resolve(opts.cwd, t);
      if (existsSync(path)) readJson(path, "flag");
      else all.problems.push({ path, message: "--mcp-config file not found" });
    }
  }
  return all;
}
