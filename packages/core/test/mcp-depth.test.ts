// ADR-0025: resources, prompts, roots, list_changed, pinning, images, tool search and OAuth.
import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runAgent } from "../src/agent";
import { MemoryStore } from "../src/auth/secrets";
import {
  buildAuthorizeUrl,
  canonicalResource,
  connectMcp,
  discoverAuth,
  exchangeMcpCode,
  expandMcpPrompt,
  type JsonRpcMessage,
  McpClient,
  type McpConnection,
  McpCredentials,
  type McpServerConfig,
  parseChallenge,
  registerClient,
  type Transport,
  toolsHash,
} from "../src/mcp";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import type { Tool } from "../src/tools/tool";
import { tempDir, toolContext } from "./helpers";

const SERVER = join(import.meta.dir, "fixtures", "mcp-server.ts");
const env = { PATH: process.env.PATH };
const server = (name = "test"): McpServerConfig => ({
  name,
  scope: "user",
  source: "test",
  transport: "stdio",
  command: process.execPath,
  args: [SERVER],
  env: {},
});
const open: McpConnection[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((c) => c.close()));
});
async function connect(opts: Partial<Parameters<typeof connectMcp>[1]> = {}) {
  const c = await connectMcp([server()], { cwd: tempDir(), env, ...opts });
  open.push(c);
  return c;
}

describe("MCP resources, prompts and roots", () => {
  test("resources are listed and read through ListMcpResourcesTool and ReadMcpResourceTool", async () => {
    const c = await connect();
    expect(c.servers[0]).toMatchObject({ resources: 1, prompts: ["review"] });
    const [list, read] = c.resourceTools as [Tool, Tool];
    const ctx = toolContext(tempDir());
    expect((await list.run({}, ctx)).content).toContain("memo://readme  readme");
    expect((await read.run({ server: "test", uri: "memo://readme" }, ctx)).content).toBe("the readme text");
    await expect(read.run({ server: "nope", uri: "x" }, ctx)).rejects.toThrow("no MCP server");
    expect(read.access({ server: "test", uri: "memo://readme" }, ctx)).toMatchObject({
      kind: "external",
      server: "test",
    });
  });

  test("a prompt expands with its arguments in order, the last taking the rest of the line", async () => {
    const c = await connect();
    const p = c.prompts[0];
    expect(p?.name).toBe("mcp__test__review");
    expect(await expandMcpPrompt(p as never, "src/a.ts style and naming")).toBe(
      "Review src/a.ts for style and naming.",
    );
    expect(await expandMcpPrompt(p as never, "src/a.ts")).toBe("Review src/a.ts for bugs.");
    await expect(expandMcpPrompt(p as never, "")).rejects.toThrow("needs file");
  });

  test("roots/list is answered with the working folder", async () => {
    const sent: JsonRpcMessage[] = [];
    let deliver: (m: JsonRpcMessage) => void = () => {};
    const t: Transport = {
      start: async (on) => {
        deliver = on;
      },
      send: async (m) => {
        sent.push(m);
        if (m.method === "initialize") deliver({ jsonrpc: "2.0", id: m.id as number, result: { capabilities: {} } });
      },
      close: async () => {},
    };
    const client = new McpClient("x", t, "1", ["/work/proj"]);
    await client.connect();
    expect((sent[0] as { params: { capabilities: unknown } }).params.capabilities).toEqual({
      roots: { listChanged: false },
    });
    deliver({ jsonrpc: "2.0", id: "r1", method: "roots/list" });
    expect(sent.at(-1)).toEqual({
      jsonrpc: "2.0",
      id: "r1",
      result: { roots: [{ uri: "file:///work/proj", name: "proj" }] },
    });
    deliver({ jsonrpc: "2.0", id: "s1", method: "sampling/createMessage" });
    expect((sent.at(-1) as { error?: { code: number } }).error?.code).toBe(-32601);
  });
});

describe("MCP tool changes", () => {
  test("tools/list_changed reloads the server's tools", async () => {
    const c = await connect();
    expect(c.tools.map((t) => t.spec.name)).not.toContain("mcp__test__extra");
    expect(await c.refresh()).toBe(false);
    await c.tools.find((t) => t.spec.name === "mcp__test__grow")?.run({}, toolContext(tempDir()));
    await Bun.sleep(50);
    expect(await c.refresh()).toBe(true);
    expect(c.tools.map((t) => t.spec.name)).toContain("mcp__test__extra");
  });

  test("tool definitions are pinned on first sight and a change is reported", async () => {
    const pins = new Map<string, string>();
    const store = { get: (k: string) => pins.get(k), set: (k: string, h: string) => void pins.set(k, h) };
    expect((await connect({ pins: store })).servers[0]?.pin).toBe("new");
    expect(pins.get("user:test")).toMatch(/^[0-9a-f]{16}$/);
    expect((await connect({ pins: store })).servers[0]?.pin).toBe("same");
    pins.set("user:test", "0000000000000000");
    expect((await connect({ pins: store })).servers[0]?.pin).toBe("changed");
    // The pin is not moved by a change; accepting it is the user's call.
    expect(pins.get("user:test")).toBe("0000000000000000");
    expect(toolsHash([{ name: "a", description: "x" }])).not.toBe(toolsHash([{ name: "a", description: "y" }]));
  });

  test("images in results go to models that can see", async () => {
    const c = await connect();
    const echo = c.tools.find((t) => t.spec.name === "mcp__test__echo") as Tool;
    const seeing = await echo.run({ text: "hi" }, { ...toolContext(tempDir()), vision: true });
    expect(seeing.images).toEqual([{ mediaType: "image/png", data: "" }]);
    expect(seeing.content).toContain("[image image/png attached]");
  });
});

describe("tool search", () => {
  const deferredTool = (name: string, description: string): Tool => ({
    spec: { name, description, inputSchema: { type: "object" } },
    parse: (r) => r,
    access: () => ({ kind: "read", paths: [], summary: name }),
    run: async () => ({ content: `${name} ran` }),
  });

  test("deferred tools are listed by name, loaded with ToolSearch, then callable", async () => {
    const provider = new FakeProvider([
      callTool("ToolSearch", { query: "select:mcp__gh__search_issues" }),
      callTool("mcp__gh__search_issues", {}),
      say("done"),
    ]);
    const res = await runAgent({
      provider,
      model: "fake",
      prompt: "find issues",
      cwd: tempDir(),
      tools: [],
      deferredTools: [
        deferredTool("mcp__gh__search_issues", "Search issues"),
        deferredTool("mcp__gh__create_pr", "Open a PR"),
      ],
      permissions: { mode: "bypassPermissions", allow: [], deny: [] },
      ask: async () => true,
    });
    expect(res.result).toBe("done");
    const [first, second] = provider.requests;
    expect(first?.system).toContain("<deferred_tools>");
    expect(first?.system).toContain("mcp__gh__create_pr");
    expect(first?.tools.map((t) => t.name)).toEqual(["ToolSearch"]);
    expect(second?.tools.map((t) => t.name)).toEqual(["ToolSearch", "mcp__gh__search_issues"]);
    const results = res.items.filter((i) => i.kind === "tool_result").map((i) => (i as { content: string }).content);
    expect(results[0]).toContain('"name":"mcp__gh__search_issues"');
    expect(results[1]).toBe("mcp__gh__search_issues ran");
  });

  test("keyword search ranks names over descriptions; no match is an error", async () => {
    const provider = new FakeProvider([
      callTool("ToolSearch", { query: "pull request" }),
      callTool("ToolSearch", { query: "zzz" }),
      say("ok"),
    ]);
    const res = await runAgent({
      provider,
      model: "fake",
      prompt: "x",
      cwd: tempDir(),
      tools: [],
      deferredTools: [deferredTool("mcp__gh__create_pr", "Open a pull request")],
      permissions: { mode: "default", allow: [], deny: [] },
      ask: async () => false,
    });
    const results = res.items.filter((i) => i.kind === "tool_result") as { content: string; isError?: boolean }[];
    expect(results[0]?.content).toContain("mcp__gh__create_pr");
    expect(results[1]?.isError).toBe(true);
  });

  test("refreshTools swaps the tool list before the next request", async () => {
    const provider = new FakeProvider([callTool("Glob", { pattern: "*" }), say("ok")]);
    let calls = 0;
    await runAgent({
      provider,
      model: "fake",
      prompt: "x",
      cwd: tempDir(),
      tools: [],
      permissions: { mode: "bypassPermissions", allow: [], deny: [] },
      ask: async () => true,
      refreshTools: async () => (++calls === 2 ? { tools: [deferredTool("mcp__new__tool", "new")] } : undefined),
    });
    expect(provider.requests[0]?.tools.map((t) => t.name)).toEqual([]);
    expect(provider.requests[1]?.tools.map((t) => t.name)).toEqual(["mcp__new__tool"]);
  });
});

describe("MCP OAuth", () => {
  const MCP = "https://mcp.example.com/mcp";
  function fakeAuth() {
    const calls: { url: string; body?: string }[] = [];
    let issued = 0;
    const f = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? String(init.body) : undefined;
      calls.push({ url, ...(body ? { body } : {}) });
      const json = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      if (url === "https://mcp.example.com/.well-known/oauth-protected-resource/mcp")
        return json({
          resource: MCP,
          authorization_servers: ["https://auth.example.com/tenant"],
          scopes_supported: ["read", "write"],
        });
      if (url === "https://auth.example.com/.well-known/oauth-authorization-server/tenant")
        return json({
          issuer: "https://auth.example.com/tenant",
          authorization_endpoint: "https://auth.example.com/tenant/authorize",
          token_endpoint: "https://auth.example.com/tenant/token",
          registration_endpoint: "https://auth.example.com/tenant/register",
          code_challenge_methods_supported: ["S256"],
        });
      if (url.endsWith("/register")) return json({ client_id: "dyn-123" }, 201);
      if (url.endsWith("/token")) {
        issued++;
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "refresh_token" && p.get("refresh_token") === "dead")
          return json({ error: "invalid_grant" }, 400);
        return json({ access_token: `at-${issued}`, refresh_token: `rt-${issued}`, expires_in: 3600 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { f, calls };
  }

  test("discovery follows resource metadata to the authorization server", async () => {
    const { f } = fakeAuth();
    expect(parseChallenge('Bearer resource_metadata="https://x/y", scope="a b"')).toEqual({
      resourceMetadata: "https://x/y",
      scope: "a b",
    });
    const d = await discoverAuth(f, MCP);
    expect(d.resource).toBe(canonicalResource(MCP));
    expect(d.authServer.token_endpoint).toBe("https://auth.example.com/tenant/token");
    expect(d.scope).toBe("read write");
  });

  test("registration, the authorize URL, code exchange and refresh carry the resource", async () => {
    const { f, calls } = fakeAuth();
    const d = await discoverAuth(f, MCP);
    const client = await registerClient(f, d.authServer, "http://127.0.0.1:33418/callback");
    expect(JSON.parse(calls.at(-1)?.body ?? "{}")).toMatchObject({ token_endpoint_auth_method: "none" });
    const reg = { resource: d.resource, authServer: d.authServer, client, scope: "read" };
    const url = new URL(buildAuthorizeUrl({ reg, state: "st", challenge: "ch" }));
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dyn-123",
      code_challenge_method: "S256",
      resource: MCP,
      scope: "read",
      state: "st",
    });
    const tokens = await exchangeMcpCode(f, reg, "code", "verifier");
    expect(new URLSearchParams(calls.at(-1)?.body).get("resource")).toBe(MCP);

    const home = tempDir("teh-home-");
    const creds = new McpCredentials(home, new MemoryStore(), f);
    creds.saveRegistration(MCP, reg);
    creds.saveTokens(MCP, tokens);
    expect(await creds.accessToken(MCP)).toBe("at-1");
    creds.saveTokens(MCP, { ...tokens, expiresAt: Date.now() });
    expect(await creds.accessToken(MCP)).toBe("at-2");
    creds.saveTokens(MCP, { accessToken: "old", refreshToken: "dead", expiresAt: Date.now() });
    expect(await creds.accessToken(MCP)).toBeUndefined();
    expect(creds.tokens(MCP)).toBeUndefined();
  });

  test("a server without PKCE support is refused", async () => {
    const f = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.includes("oauth-authorization-server"))
        return Response.json({
          issuer: "https://a",
          authorization_endpoint: "https://a/x",
          token_endpoint: "https://a/t",
        });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    await expect(discoverAuth(f, "https://a/mcp")).rejects.toThrow("PKCE");
  });

  test("an HTTP server gets the bearer token, and a 401 is recorded for sign-in", async () => {
    const seen: (string | null)[] = [];
    const srv = Bun.serve({
      port: 0,
      fetch: async (req) => {
        seen.push(req.headers.get("authorization"));
        if (req.headers.get("authorization") !== "Bearer good")
          return new Response("no", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="x"' } });
        const m = (await req.json()) as JsonRpcMessage;
        if (m.id === undefined) return new Response(null, { status: 202 });
        const result = m.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: {} } : { tools: [] };
        return Response.json({ jsonrpc: "2.0", id: m.id, result });
      },
    });
    try {
      const cfg: McpServerConfig = {
        name: "web",
        scope: "user",
        source: "t",
        transport: "http",
        url: `http://127.0.0.1:${srv.port}/mcp`,
        headers: {},
      };
      const bad = await connectMcp([cfg], { cwd: tempDir(), env, token: async () => "nope" });
      expect(bad.servers[0]).toMatchObject({ ok: false, needsAuth: true });
      expect(bad.servers[0]?.error).toContain("teh mcp login web");
      const good = await connectMcp([cfg], { cwd: tempDir(), env, token: async () => "good" });
      open.push(good);
      expect(good.servers[0]?.ok).toBe(true);
      expect(seen.at(-1)).toBe("Bearer good");
    } finally {
      srv.stop(true);
    }
  });
});

describe("sandboxed stdio servers", () => {
  test('a server with "sandbox": true starts through the sandbox; others do not', async () => {
    const wrapped: string[][] = [];
    const sandbox = {
      kind: "seatbelt" as const,
      wrap: (argv: string[], level: string) => {
        wrapped.push([level, ...argv]);
        return ["/usr/bin/env", "TEH_SANDBOXED=1", ...argv];
      },
      describe: () => "fake",
    };
    const c = await connectMcp([{ ...server("boxed"), sandbox: true } as McpServerConfig, server("plain")], {
      cwd: tempDir(),
      env,
      sandbox,
    });
    open.push(c);
    expect(c.servers.map((s) => [s.name, s.ok, s.sandboxed ?? false])).toEqual([
      ["boxed", true, true],
      ["plain", true, false],
    ]);
    expect(wrapped).toHaveLength(1);
    expect(wrapped[0]?.[0]).toBe("workspace-write");
  });
});
