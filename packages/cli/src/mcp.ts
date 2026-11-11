// MCP servers for a run, and `teh mcp` (ADR-0017).
import { relative } from "node:path";
import {
  connectMcp,
  findProjectRoot,
  isTrusted,
  loadMcpConfig,
  type McpConnection,
  type McpServerConfig,
  tehHome,
  VERSION,
} from "@everything-harness/core";
import type { Io } from "./cli";

export type McpPlan = { servers: McpServerConfig[]; untrusted: McpServerConfig[]; warnings: string[] };

// Which servers to start. A repo's .mcp.json starts programs, so it waits for `teh trust`.
export function planMcp(io: Io, flags: string[], strict: boolean): McpPlan {
  const root = findProjectRoot(io.cwd);
  const home = tehHome(io.env);
  const loaded = loadMcpConfig({ tehHome: home, projectRoot: root, cwd: io.cwd, env: io.env, flags });
  const warnings = loaded.problems.map((p) => `MCP config ${p.path}: ${p.message}`);
  let servers = strict ? loaded.servers.filter((s) => s.scope === "flag") : loaded.servers;
  const trusted = isTrusted(home, root);
  const untrusted = trusted ? [] : servers.filter((s) => s.scope === "project");
  servers = servers.filter((s) => !untrusted.includes(s));
  if (untrusted.length)
    warnings.push(
      `not starting MCP server(s) ${untrusted.map((s) => s.name).join(", ")} from .mcp.json until you trust this folder: review it, then run \`teh trust\``,
    );
  return { servers, untrusted, warnings };
}

export function mcpTimeout(io: Io): number {
  const ms = Number(io.env.MCP_TIMEOUT);
  return Number.isFinite(ms) && ms > 0 ? ms : 30_000;
}

export async function startMcp(io: Io, servers: McpServerConfig[]): Promise<McpConnection | undefined> {
  if (!servers.length) return undefined;
  const conn = await connectMcp(servers, {
    cwd: io.cwd,
    env: io.env,
    timeoutMs: mcpTimeout(io),
    clientVersion: VERSION,
  });
  for (const s of conn.servers) if (!s.ok) io.err(`teh: warning: MCP server ${s.name} is not available: ${s.error}\n`);
  return conn;
}

const where = (root: string, s: McpServerConfig) =>
  s.scope === "flag" ? "--mcp-config" : relative(root, s.source).startsWith("..") ? s.source : relative(root, s.source);

const describe = (s: McpServerConfig) => (s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url);

// `teh mcp`: start each configured server, list its tools, and stop it again.
export async function printMcp(io: Io, flags: string[], strict: boolean): Promise<number> {
  const root = findProjectRoot(io.cwd);
  const plan = planMcp(io, flags, strict);
  if (!plan.servers.length && !plan.untrusted.length) {
    io.out(
      'No MCP servers configured. Add them to .mcp.json in the project or ~/.teh/mcp.json, in Claude Code\'s format:\n  {"mcpServers": {"name": {"command": "npx", "args": ["-y", "some-mcp-server"]}}}\n',
    );
    for (const w of plan.warnings) io.err(`teh: warning: ${w}\n`);
    return 0;
  }
  const conn = await connectMcp(plan.servers, {
    cwd: io.cwd,
    env: io.env,
    timeoutMs: mcpTimeout(io),
    clientVersion: VERSION,
  });
  try {
    io.out("MCP servers (tools are named mcp__<server>__<tool>; allow one with --allowedTools mcp__<server>):\n");
    for (const [i, s] of plan.servers.entries()) {
      const st = conn.servers[i];
      const state = st?.ok ? `${st.tools.length} tool(s)` : `failed: ${st?.error}`;
      io.out(`  ${s.name.padEnd(20)} ${s.transport.padEnd(6)} ${where(root, s).padEnd(16)} ${state}\n`);
      io.out(`    ${describe(s)}\n`);
      for (const t of st?.tools ?? []) io.out(`    · ${t}\n`);
    }
    for (const s of plan.untrusted) {
      io.out(
        `  ${s.name.padEnd(20)} ${s.transport.padEnd(6)} ${where(root, s).padEnd(16)} not started: run \`teh trust\`\n`,
      );
      io.out(`    ${describe(s)}\n`);
    }
    for (const w of plan.warnings.filter((w) => !w.startsWith("not starting"))) io.err(`teh: warning: ${w}\n`);
    return conn.servers.every((s) => s.ok) ? 0 : 1;
  } finally {
    await conn.close();
  }
}
