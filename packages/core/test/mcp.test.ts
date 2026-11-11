import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, runAgent } from "../src/agent";
import {
  connectMcp,
  expandEnv,
  loadMcpConfig,
  type McpConnection,
  type McpServerConfig,
  mcpToolName,
  parseMcpServers,
} from "../src/mcp";
import { decide, mcpRuleMatches, parseRules } from "../src/permissions";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { builtinTools } from "../src/tools";
import { handle } from "./fixtures/mcp-server";
import { tempDir, toolContext } from "./helpers";

const SERVER = join(import.meta.dir, "fixtures", "mcp-server.ts");
const env = { PATH: process.env.PATH };

const stdioServer = (name = "test", command = process.execPath): McpServerConfig => ({
  name,
  scope: "user",
  source: "test",
  transport: "stdio",
  command,
  args: [SERVER],
  env: {},
});

const open: McpConnection[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});
async function connect(servers: McpServerConfig[], opts: { timeoutMs?: number; fetch?: typeof fetch } = {}) {
  const c = await connectMcp(servers, { cwd: tempDir(), env, ...opts });
  open.push(c);
  return c;
}

describe("MCP config", () => {
  test("reads Claude Code's .mcp.json, expands environment variables, reports problems", () => {
    const r = parseMcpServers(
      {
        mcpServers: {
          files: { command: "npx", args: ["-y", "server", `\${ROOT:-/tmp}`], env: { TOKEN: `\${TOKEN}` } },
          remote: { type: "http", url: "https://example.com/mcp", headers: { Authorization: `Bearer \${API_KEY}` } },
          old: { type: "sse", url: "https://example.com/sse" },
          "bad name": { command: "x" },
          nocmd: {},
        },
      },
      "project",
      ".mcp.json",
      { TOKEN: "t0k" },
    );
    expect(r.servers).toEqual([
      {
        name: "files",
        scope: "project",
        source: ".mcp.json",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server", "/tmp"],
        env: { TOKEN: "t0k" },
      },
      {
        name: "remote",
        scope: "project",
        source: ".mcp.json",
        transport: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer " },
      },
    ]);
    const problems = r.problems.map((p) => p.message).join("\n");
    expect(problems).toContain("not set: API_KEY");
    expect(problems).toContain("old SSE transport is not supported");
    expect(problems).toContain('server name "bad name"');
    expect(problems).toContain('server "nocmd" needs a "command"');
    expect(expandEnv(`a\${X}b`, { X: "1" })).toEqual({ text: "a1b", missing: [] });
  });

  test("project overrides user; --mcp-config (file or JSON) overrides both", () => {
    const home = tempDir();
    const root = tempDir();
    writeFileSync(
      join(home, "mcp.json"),
      JSON.stringify({ mcpServers: { a: { command: "user-a" }, b: { command: "user-b" } } }),
    );
    writeFileSync(join(root, ".mcp.json"), JSON.stringify({ mcpServers: { a: { command: "project-a" } } }));
    const r = loadMcpConfig({
      tehHome: home,
      projectRoot: root,
      cwd: root,
      env: {},
      flags: ['{"mcpServers": {"b": {"command": "flag-b"}}}', "missing.json"],
    });
    expect(r.servers.map((s) => [s.name, s.scope, s.transport === "stdio" ? s.command : ""])).toEqual([
      ["a", "project", "project-a"],
      ["b", "flag", "flag-b"],
    ]);
    expect(r.problems[0]?.message).toBe("--mcp-config file not found");
  });
});

describe("MCP client over stdio", () => {
  test("connects, pages through tools/list, calls tools and answers the server's ping", async () => {
    const c = await connect([stdioServer()]);
    expect(c.servers[0]).toMatchObject({
      name: "test",
      ok: true,
      tools: ["mcp__test__echo", "mcp__test__fail", "mcp__test__slow", "mcp__test__touch"],
      serverInfo: { name: "test-server", version: "1.2.3" },
    });
    expect(c.instructions).toEqual([{ server: "test", text: "Use echo to repeat text." }]);
    const echo = c.tools.find((t) => t.spec.name === "mcp__test__echo");
    expect(echo?.spec.inputSchema).toMatchObject({ required: ["text"] });
    const ctx = toolContext(tempDir());
    expect(await echo?.run({ text: "hi" }, ctx)).toEqual({
      content: "echo: hi\n[image image/png omitted]",
      isError: false,
    });
    expect(echo?.access({ text: "hi" }, ctx)).toEqual({
      kind: "external",
      server: "test",
      summary: 'test: Echo {"text":"hi"}',
    });
    const fail = c.tools.find((t) => t.spec.name === "mcp__test__fail");
    expect(await fail?.run({}, ctx)).toEqual({ content: "it broke", isError: true });
  });

  test("a call that never answers times out or is interrupted; a broken server is reported, not thrown", async () => {
    const c = await connect([stdioServer(), stdioServer("broken", "teh-no-such-command-xyz")]);
    expect(c.servers[1]).toMatchObject({ name: "broken", ok: false });
    expect(c.servers[1]?.error).toContain("teh-no-such-command-xyz");
    const slow = c.tools.find((t) => t.spec.name === "mcp__test__slow");
    const ac = new AbortController();
    const pending = slow?.run({}, { ...toolContext(tempDir()), signal: ac.signal });
    ac.abort();
    await expect(pending).rejects.toThrow("tools/call interrupted");
  });

  test("tool names fit provider limits", () => {
    expect(mcpToolName("gh", "issues.search")).toBe("mcp__gh__issues_search");
    expect(mcpToolName("server", "x".repeat(100))).toHaveLength(64);
  });
});

describe("MCP client over streamable HTTP", () => {
  const servers: ReturnType<typeof Bun.serve>[] = [];
  afterEach(() => {
    for (const s of servers.splice(0)) s.stop(true);
  });

  function serve(mode: "json" | "sse", seen: { headers: Headers[]; deleted: boolean }) {
    const s = Bun.serve({
      port: 0,
      async fetch(req) {
        seen.headers.push(req.headers);
        if (req.method === "DELETE") {
          seen.deleted = true;
          return new Response(null, { status: 204 });
        }
        if (req.headers.get("authorization") !== "Bearer secret") return new Response("no", { status: 401 });
        const msg = await req.json();
        const reply = handle(msg as Parameters<typeof handle>[0]);
        const headers = { "mcp-session-id": "sess-1" };
        if (!reply) return new Response(null, { status: 202, headers });
        if (mode === "json") return Response.json(reply, { headers });
        const body = `event: message\nid: 1\ndata: ${JSON.stringify(reply)}\n\n`;
        return new Response(body, { headers: { ...headers, "content-type": "text/event-stream" } });
      },
    });
    servers.push(s);
    return `http://localhost:${s.port}/mcp`;
  }

  for (const mode of ["json", "sse"] as const) {
    test(`${mode} replies; session id and protocol version are sent back; DELETE on close`, async () => {
      const seen = { headers: [] as Headers[], deleted: false };
      const url = serve(mode, seen);
      const c = await connectMcp(
        [
          {
            name: "web",
            scope: "flag",
            source: "t",
            transport: "http",
            url,
            headers: { Authorization: "Bearer secret" },
          },
        ],
        { cwd: tempDir(), env },
      );
      expect(c.servers[0]).toMatchObject({ ok: true });
      const echo = c.tools.find((t) => t.spec.name === "mcp__web__echo");
      expect((await echo?.run({ text: "yo" }, toolContext(tempDir())))?.content).toStartWith("echo: yo");
      const last = seen.headers.at(-1);
      expect(last?.get("mcp-session-id")).toBe("sess-1");
      expect(last?.get("mcp-protocol-version")).toBe("2025-06-18");
      await c.close();
      expect(seen.deleted).toBe(true);
    });
  }

  test("401 explains that credentials are needed", async () => {
    const url = serve("json", { headers: [], deleted: false });
    const c = await connect([{ name: "web", scope: "flag", source: "t", transport: "http", url, headers: {} }]);
    expect(c.servers[0]?.error).toContain("HTTP 401");
    expect(c.servers[0]?.error).toContain("Authorization header");
  });
});

describe("MCP permissions", () => {
  const access = { kind: "external" as const, server: "github", summary: "github: search" };
  const ctx = toolContext(tempDir());
  const tool = "mcp__github__search_issues";
  const config = (mode: "default" | "plan" | "bypassPermissions", allow: string[] = [], deny: string[] = []) => ({
    mode,
    allow: parseRules(allow),
    deny: parseRules(deny),
  });

  test("asks by default; server-wide and per-tool rules allow; deny wins; plan mode needs a rule", () => {
    expect(decide(tool, access, config("default"), ctx)).toMatchObject({ behavior: "ask", suggestion: tool });
    expect(decide(tool, access, config("default", ["mcp__github"]), ctx).behavior).toBe("allow");
    expect(decide(tool, access, config("default", ["mcp__github__*"]), ctx).behavior).toBe("allow");
    expect(decide(tool, access, config("default", [tool]), ctx).behavior).toBe("allow");
    expect(decide(tool, access, config("default", ["mcp__git"]), ctx).behavior).toBe("ask");
    expect(decide(tool, access, config("bypassPermissions", [], ["mcp__github"]), ctx).behavior).toBe("deny");
    expect(decide(tool, access, config("plan"), ctx).behavior).toBe("deny");
    expect(decide(tool, access, config("plan", ["mcp__github"]), ctx).behavior).toBe("allow");
    expect(mcpRuleMatches("mcp__github", "mcp__githubx__a")).toBe(false);
  });
});

describe("runAgent with MCP tools", () => {
  test("the model calls an MCP tool once allowed; server notes reach the system prompt", async () => {
    const c = await connect([stdioServer()]);
    const cwd = tempDir();
    mkdirSync(join(cwd, "sub"));
    const target = join(cwd, "sub", "made.txt");
    const provider = new FakeProvider([
      callTool("mcp__test__echo", { text: "hello" }, "c1"),
      callTool("mcp__test__touch", { path: target }, "c2"),
      say("done"),
    ]);
    const events: AgentEvent[] = [];
    await runAgent({
      provider,
      model: "fake",
      prompt: "go",
      cwd,
      tools: [...builtinTools, ...c.tools],
      mcpInstructions: c.instructions,
      permissions: { mode: "default", allow: parseRules(["mcp__test__echo"]), deny: [] },
      ask: async () => false,
      onEvent: (e) => events.push(e),
    });
    expect(provider.requests[0]?.system).toContain('<server name="test">\nUse echo to repeat text.');
    expect(provider.requests[0]?.tools.map((t) => t.name)).toContain("mcp__test__touch");
    expect(provider.requests[1]?.items.at(-1)).toMatchObject({ content: "echo: hello\n[image image/png omitted]" });
    // touch was not allowed, and headless runs cannot ask.
    expect(existsSync(target)).toBe(false);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "approval", behavior: "deny", suggestion: "mcp__test__touch" }),
    );
  });
});
