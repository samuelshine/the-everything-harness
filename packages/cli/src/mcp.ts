// MCP servers for a run, and `teh mcp` (ADR-0017, ADR-0025).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  buildAuthorizeUrl,
  connectMcp,
  discoverAuth,
  estimateTokens,
  exchangeMcpCode,
  findProjectRoot,
  isTrusted,
  loadMcpConfig,
  loadPlugins,
  type McpConnection,
  McpCredentials,
  type McpRegistration,
  type McpServerConfig,
  type PinStore,
  pkce,
  pluginLabel,
  randomToken,
  registerClient,
  type Sandbox,
  secretStore,
  type Tool,
  tehHome,
  VERSION,
} from "@everything-harness/core";
import type { Io } from "./cli";
import { listenForCallback, openBrowser } from "./login";

export type McpPlan = { servers: McpServerConfig[]; untrusted: McpServerConfig[]; warnings: string[] };

// Which servers to start. A repo's .mcp.json starts programs, so it waits for `teh trust`.
export function planMcp(io: Io, flags: string[], strict: boolean): McpPlan {
  const root = findProjectRoot(io.cwd);
  const home = tehHome(io.env);
  // Enabled plugins' servers start like the user's own: installing the plugin was the trust.
  const plugins = loadPlugins(home, io.env);
  const loaded = loadMcpConfig({
    tehHome: home,
    projectRoot: root,
    cwd: io.cwd,
    env: io.env,
    flags,
    plugin: plugins.mcpServers,
  });
  const warnings = [
    ...plugins.problems.filter((p) => p.area !== "hooks").map((p) => `plugin ${p.path}: ${p.message}`),
    ...loaded.problems.map((p) => `MCP config ${p.path}: ${p.message}`),
  ];
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

// ~/.teh/mcp-pins.json: the fingerprint of each server's tool definitions when first seen.
export function pinStore(home: string): PinStore & { all(): Record<string, string> } {
  const file = join(home, "mcp-pins.json");
  const read = (): Record<string, string> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Record<string, string>) : {};
    } catch {
      return {};
    }
  };
  return {
    all: read,
    get: (k) => read()[k],
    set: (k, h) => {
      try {
        writeFileSync(file, `${JSON.stringify({ ...read(), [k]: h }, null, 2)}\n`, { mode: 0o600 });
      } catch {}
    },
  };
}

function connectOptions(io: Io, sandbox?: Sandbox) {
  const home = tehHome(io.env);
  const creds = new McpCredentials(home, secretStore(home, io.env));
  return {
    cwd: io.cwd,
    env: io.env,
    timeoutMs: mcpTimeout(io),
    clientVersion: VERSION,
    pins: pinStore(home),
    token: async (s: McpServerConfig) => (s.transport === "http" ? creds.accessToken(s.url) : undefined),
    ...(sandbox ? { sandbox } : {}),
  };
}

export async function startMcp(
  io: Io,
  servers: McpServerConfig[],
  sandbox?: Sandbox,
): Promise<McpConnection | undefined> {
  if (!servers.length) return undefined;
  const conn = await connectMcp(servers, connectOptions(io, sandbox));
  for (const s of conn.servers) {
    if (!s.ok)
      io.err(
        `teh: warning: MCP server ${s.name} is not available: ${s.error}${s.needsAuth ? `\n  sign in with: teh mcp login ${s.name}` : ""}\n`,
      );
    else if (s.pin === "changed")
      io.err(
        `teh: warning: MCP server ${s.name} changed its tool definitions since you first used it. A server can change what its tools say to steer the model; review them with \`teh mcp\`, then accept with \`teh mcp pin ${s.name}\`\n`,
      );
  }
  for (const s of servers)
    if (s.transport === "stdio" && s.sandbox && !sandbox)
      io.err(
        `teh: warning: MCP server ${s.name} asks for the sandbox, but none is available here; it runs without one\n`,
      );
  return conn;
}

// Tool search (ADR-0025): when MCP tool definitions would take more than a tenth of the
// context window, they are deferred and the model loads them with ToolSearch.
export function splitDeferred(
  mcpTools: Tool[],
  contextWindow: number | undefined,
  mode: string | undefined,
): { tools: Tool[]; deferred: Tool[] } {
  if (!mcpTools.length || mode === "off" || mode === "false") return { tools: mcpTools, deferred: [] };
  if (mode === "on" || mode === "true") return { tools: [], deferred: mcpTools };
  const cost = estimateTokens({ system: "", items: [], tools: mcpTools.map((t) => t.spec) });
  const budget = (contextWindow ?? 32_768) * 0.1;
  return cost > budget ? { tools: [], deferred: mcpTools } : { tools: mcpTools, deferred: [] };
}

const where = (root: string, s: McpServerConfig, home: string) =>
  s.scope === "flag"
    ? "--mcp-config"
    : (pluginLabel(home, s.source) ??
      (relative(root, s.source).startsWith("..") ? s.source : relative(root, s.source)));

const describe = (s: McpServerConfig) => (s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url);

// `teh mcp [login|logout|pin] [server]`.
export async function mcpCommand(
  io: Io,
  args: string[],
  flags: string[],
  strict: boolean,
  deps: { fetch?: typeof fetch; openBrowser?: (url: string) => void } = {},
): Promise<number> {
  const [verb, name] = args;
  if (!verb) return printMcp(io, flags, strict);
  const plan = planMcp(io, flags, strict);
  const all = [...plan.servers, ...plan.untrusted];
  if (verb === "pin") return pin(io, plan.servers, name);
  if (verb !== "login" && verb !== "logout") {
    io.err("teh: usage: teh mcp [login <server> | logout <server> | pin <server|all>]\n");
    return 2;
  }
  const server = all.find((s) => s.name === name);
  if (server?.transport !== "http") {
    io.err(
      `teh: ${name ? `no HTTP MCP server named "${name}"` : "name a server"}; HTTP servers: ${
        all
          .filter((s) => s.transport === "http")
          .map((s) => s.name)
          .join(", ") || "none"
      }\n`,
    );
    return 2;
  }
  const home = tehHome(io.env);
  const creds = new McpCredentials(home, secretStore(home, io.env), deps.fetch ?? fetch);
  if (verb === "logout") {
    creds.forget(server.url);
    io.err(`Signed out of ${server.name} on this machine.\n`);
    return 0;
  }
  return mcpLogin(io, server, creds, deps);
}

const CALLBACK = "/callback";
const MCP_PORT = 33418;

async function mcpLogin(
  io: Io,
  server: Extract<McpServerConfig, { transport: "http" }>,
  creds: McpCredentials,
  deps: { fetch?: typeof fetch; openBrowser?: (url: string) => void },
): Promise<number> {
  const f = deps.fetch ?? fetch;
  try {
    // Ask the server: its 401 names where to sign in.
    let challenge: string | undefined;
    const probe = await f(server.url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    }).catch(() => undefined);
    if (probe?.status === 401) challenge = probe.headers.get("www-authenticate") ?? undefined;
    await probe?.body?.cancel().catch(() => {});
    const found = await discoverAuth(f, server.url, challenge);
    const previous = creds.registration(server.url);
    // A registered redirect must match exactly, port included, so reuse its port when free.
    const wanted = previous ? Number(new URL(previous.client.redirectUri).port) : MCP_PORT;
    const listener = listenForCallback(wanted, CALLBACK);
    let client = server.oauth
      ? {
          clientId: server.oauth.clientId,
          ...(server.oauth.clientSecret ? { clientSecret: server.oauth.clientSecret } : {}),
          redirectUri: listener.redirectUri,
        }
      : previous?.authServer.issuer === found.authServer.issuer && previous.client.redirectUri === listener.redirectUri
        ? previous.client
        : undefined;
    client ??= await registerClient(f, found.authServer, listener.redirectUri);
    const scope = server.oauth?.scope ?? found.scope;
    const reg: McpRegistration = {
      resource: found.resource,
      authServer: found.authServer,
      client,
      ...(scope ? { scope } : {}),
    };
    const { verifier, challenge: codeChallenge } = pkce();
    const state = randomToken();
    const url = buildAuthorizeUrl({ reg, state, challenge: codeChallenge });
    io.err(`Signing in to ${server.name} (${new URL(found.authServer.issuer).host}): opening your browser.\n`);
    try {
      (deps.openBrowser ?? openBrowser)(url);
    } catch {
      io.err(`Open this link to continue:\n  ${url}\n`);
    }
    io.err(`Waiting for the sign-in to finish (listening on ${listener.redirectUri})…\n`);
    const params = await listener.wait(5 * 60 * 1000);
    if (!params) {
      io.err(`teh: the sign-in did not finish within 5 minutes; run \`teh mcp login ${server.name}\` again\n`);
      return 1;
    }
    if (params.get("state") !== state) {
      io.err("teh: the sign-in reply did not match this attempt (state mismatch); nothing was saved\n");
      return 1;
    }
    const code = params.get("code");
    if (!code) {
      io.err(`teh: sign-in failed: ${params.get("error_description") ?? params.get("error") ?? "no code returned"}\n`);
      return 1;
    }
    const tokens = await exchangeMcpCode(f, reg, code, verifier);
    creds.saveRegistration(server.url, reg);
    creds.saveTokens(server.url, tokens);
    io.err(`Signed in to ${server.name}. \`teh mcp\` lists its tools.\n`);
    return 0;
  } catch (e) {
    io.err(`teh: could not sign in to ${server.name}: ${(e as Error).message}\n`);
    return 1;
  }
}

async function pin(io: Io, servers: McpServerConfig[], name: string | undefined): Promise<number> {
  const chosen = name === "all" ? servers : servers.filter((s) => s.name === name);
  if (!chosen.length) {
    io.err(`teh: usage: teh mcp pin <server|all>; servers: ${servers.map((s) => s.name).join(", ")}\n`);
    return 2;
  }
  const home = tehHome(io.env);
  const pins = pinStore(home);
  // Connect without pinning, then pin what was found.
  const { pins: _, ...options } = connectOptions(io);
  const conn = await connectMcp(chosen, options);
  try {
    for (const s of conn.servers) {
      if (!s.ok || !s.toolsHash) {
        io.err(`teh: ${s.name}: ${s.error ?? "no tools"}\n`);
        continue;
      }
      pins.set(`${s.scope}:${s.name}`, s.toolsHash);
      io.out(`Pinned ${s.name}'s ${s.tools.length} tool definition(s).\n`);
    }
  } finally {
    await conn.close();
  }
  return 0;
}

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
  const conn = await connectMcp(plan.servers, connectOptions(io));
  try {
    io.out("MCP servers (tools are named mcp__<server>__<tool>; allow one with --allowedTools mcp__<server>):\n");
    for (const [i, s] of plan.servers.entries()) {
      const st = conn.servers[i];
      const extras = st?.ok
        ? [
            `${st.tools.length} tool(s)`,
            ...(st.resources ? [`${st.resources} resource(s)`] : []),
            ...(st.prompts.length ? [`${st.prompts.length} prompt(s)`] : []),
            ...(st.sandboxed ? ["sandboxed"] : []),
            ...(st.pin === "changed" ? [`TOOLS CHANGED since pinned: \`teh mcp pin ${s.name}\` accepts`] : []),
          ].join(", ")
        : `failed: ${st?.error}${st?.needsAuth ? ` (run \`teh mcp login ${s.name}\`)` : ""}`;
      io.out(
        `  ${s.name.padEnd(20)} ${s.transport.padEnd(6)} ${where(root, s, tehHome(io.env)).padEnd(16)} ${extras}\n`,
      );
      io.out(`    ${describe(s)}\n`);
      for (const t of st?.tools ?? []) io.out(`    · ${t}\n`);
      for (const p of st?.prompts ?? []) io.out(`    / /mcp__${s.name}__${p}\n`);
    }
    for (const s of plan.untrusted) {
      io.out(
        `  ${s.name.padEnd(20)} ${s.transport.padEnd(6)} ${where(root, s, tehHome(io.env)).padEnd(16)} not started: run \`teh trust\`\n`,
      );
      io.out(`    ${describe(s)}\n`);
    }
    for (const w of plan.warnings.filter((w) => !w.startsWith("not starting"))) io.err(`teh: warning: ${w}\n`);
    return conn.servers.every((s) => s.ok) ? 0 : 1;
  } finally {
    await conn.close();
  }
}
