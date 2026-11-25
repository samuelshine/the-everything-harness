import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@everything-harness/core";
import type { Io } from "../src/cli";
import { mcpCommand, pinStore, splitDeferred } from "../src/mcp";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-mcp-")));
const SERVER = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "mcp-server.ts");

function io(home: string, cwd = temp()) {
  let out = "";
  let err = "";
  const value: Io = {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    env: { TEH_HOME: home, HOME: home, PATH: process.env.PATH, TEH_SECRET_STORE: "file" },
    cwd,
    stdin: async () => undefined,
  };
  return { io: value, out: () => out, err: () => err };
}

test("teh mcp login signs in through discovery, registration and PKCE, and logout forgets it", async () => {
  const home = temp();
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { web: { type: "http", url: "https://mcp.example.com/mcp" } } }),
  );
  let challenge = "";
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === "https://mcp.example.com/mcp")
      return new Response("", {
        status: 401,
        headers: { "www-authenticate": 'Bearer resource_metadata="https://mcp.example.com/prm"' },
      });
    if (url === "https://mcp.example.com/prm")
      return Response.json({
        resource: "https://mcp.example.com/mcp",
        authorization_servers: ["https://auth.example.com"],
      });
    if (url === "https://auth.example.com/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        token_endpoint: "https://auth.example.com/token",
        registration_endpoint: "https://auth.example.com/register",
        code_challenge_methods_supported: ["S256"],
      });
    if (url.endsWith("/register")) return Response.json({ client_id: "c-1" });
    if (url.endsWith("/token")) {
      const p = new URLSearchParams(String(init?.body));
      // PKCE: the verifier must hash to the challenge sent to the browser.
      const hashed = new Bun.CryptoHasher("sha256").update(p.get("code_verifier") ?? "").digest("base64url");
      if (hashed !== challenge || p.get("code") !== "CODE")
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
  const t = io(home);
  const code = await mcpCommand(t.io, ["login", "web"], [], false, {
    fetch: f,
    openBrowser: (url) => {
      const q = new URL(url).searchParams;
      challenge = q.get("code_challenge") ?? "";
      expect(q.get("resource")).toBe("https://mcp.example.com/mcp");
      const back = new URL(q.get("redirect_uri") as string);
      back.searchParams.set("code", "CODE");
      back.searchParams.set("state", q.get("state") as string);
      void fetch(back).catch(() => {});
    },
  });
  expect(t.err()).toContain("Signed in to web");
  expect(code).toBe(0);
  const secrets = () =>
    readdirSync(join(home, "auth", "secrets"))
      .map((f) => readFileSync(join(home, "auth", "secrets", f), "utf8"))
      .join("\n");
  expect(secrets()).toContain('"accessToken":"tok"');

  const out = io(home);
  expect(await mcpCommand(out.io, ["logout", "web"], [], false)).toBe(0);
  expect(secrets()).not.toContain('"accessToken":"tok"');
  expect(await mcpCommand(io(home).io, ["login", "nope"], [], false)).toBe(2);
});

test("teh mcp shows resources, prompts and a changed pin; teh mcp pin accepts it", async () => {
  const home = temp();
  writeFileSync(
    join(home, "mcp.json"),
    JSON.stringify({ mcpServers: { test: { command: process.execPath, args: [SERVER] } } }),
  );
  const first = io(home);
  expect(await mcpCommand(first.io, [], [], false)).toBe(0);
  expect(first.out()).toContain("1 resource(s), 1 prompt(s)");
  expect(first.out()).toContain("/mcp__test__review");
  const pins = pinStore(home);
  expect(pins.get("user:test")).toBeDefined();
  pins.set("user:test", "changed-on-purpose");
  const second = io(home);
  await mcpCommand(second.io, [], [], false);
  expect(second.out()).toContain("TOOLS CHANGED");
  const accept = io(home);
  expect(await mcpCommand(accept.io, ["pin", "test"], [], false)).toBe(0);
  expect(pins.get("user:test")).not.toBe("changed-on-purpose");
  expect(existsSync(join(home, "mcp-pins.json"))).toBe(true);
});

test("MCP tools are deferred when their definitions would take over a tenth of the window", () => {
  const tool = (i: number): Tool => ({
    spec: { name: `mcp__s__t${i}`, description: "x".repeat(400), inputSchema: { type: "object" } },
    parse: (r) => r,
    access: () => ({ kind: "read", paths: [], summary: "" }),
    run: async () => ({ content: "" }),
  });
  const many = Array.from({ length: 30 }, (_, i) => tool(i));
  expect(splitDeferred(many, 200_000, undefined).deferred).toHaveLength(0);
  expect(splitDeferred(many, 8_000, undefined).deferred).toHaveLength(30);
  expect(splitDeferred(many, 8_000, "off").deferred).toHaveLength(0);
  expect(splitDeferred(many.slice(0, 1), 200_000, "on").deferred).toHaveLength(1);
});
