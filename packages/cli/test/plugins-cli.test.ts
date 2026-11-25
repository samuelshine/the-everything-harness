import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeProvider, type Provider, say } from "@everything-harness/core";
import { type Deps, run } from "../src/cli";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-plugin-")));
const SERVER = join(import.meta.dir, "..", "..", "core", "test", "fixtures", "mcp-server.ts");

// "${CLAUDE_PLUGIN_ROOT}" written out, without tripping the template-string lint.
const ROOT = `$\{CLAUDE_PLUGIN_ROOT}`;

function put(root: string, rel: string, text: string | object) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), typeof text === "string" ? text : JSON.stringify(text));
}

// A plugin with a command, a skill, a hook and an MCP server (the test fixture, started
// through the plugin root).
function makePlugin(name = "fmt") {
  const root = temp();
  put(root, ".claude-plugin/plugin.json", { name, version: "1.0.0", description: "Formatting" });
  put(root, "commands/format.md", "Format $ARGUMENTS and nothing else.\n");
  put(root, "skills/pretty/SKILL.md", "---\nname: pretty\ndescription: Make code pretty.\n---\nBe pretty.\n");
  put(root, "hooks/hooks.json", {
    hooks: { PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `${ROOT}/fmt.sh` }] }] },
  });
  put(root, ".mcp.json", {
    mcpServers: { tools: { command: process.execPath, args: [`${ROOT}/server.ts`] } },
  });
  copyFileSync(SERVER, join(root, "server.ts"));
  return root;
}

type CallOpts = { home?: string; cwd?: string; confirm?: boolean; turns?: ReturnType<typeof say>[] };

async function call(argv: string[], opts: CallOpts = {}) {
  let out = "";
  let err = "";
  const home = opts.home ?? temp();
  const cwd = opts.cwd ?? temp();
  const fake = new FakeProvider(opts.turns ?? []);
  const deps: Deps = { provider: () => fake as Provider };
  const code = await run(
    argv,
    {
      out: (s) => (out += s),
      err: (s) => (err += s),
      env: { TEH_HOME: home, HOME: home, PATH: process.env.PATH, TEH_SECRET_STORE: "file" },
      cwd,
      stdin: async () => undefined,
      ...(opts.confirm === undefined ? {} : { confirm: async () => opts.confirm as boolean }),
    },
    deps,
  );
  return { code, out, err, home, cwd, fake };
}

describe("teh plugin", () => {
  test("install shows what the plugin contains and refuses without --yes when there is no terminal", async () => {
    const src = makePlugin();
    const r = await call(["plugin", "install", src]);
    expect(r.code).toBe(2);
    expect(r.out).toContain("Plugin fmt 1.0.0: Formatting");
    expect(r.out).toContain("/format");
    expect(r.out).toContain("pretty");
    expect(r.out).toContain("PostToolUse[Edit]");
    expect(r.out).toContain("MCP server   tools");
    expect(r.out).toContain("A plugin is code");
    expect(r.err).toContain("pass --yes");
    // Nothing was installed and no staging folder was left.
    expect(readdirSync(join(r.home, "plugins"))).toEqual([]);
    expect((await call(["plugin", "list"], { home: r.home })).out).toContain("No plugins installed");
  });

  test("an interactive no installs nothing; an interactive yes installs", async () => {
    const src = makePlugin();
    const home = temp();
    const no = await call(["plugin", "install", src], { home, confirm: false });
    expect(no.code).toBe(1);
    expect(no.err).toContain("Not installed");
    expect(existsSync(join(home, "plugins", "fmt"))).toBe(false);
    const yes = await call(["plugin", "install", src], { home, confirm: true });
    expect(yes.code).toBe(0);
    expect(yes.out).toContain("Installed fmt");
    expect(existsSync(join(home, "plugins", "fmt", "commands", "format.md"))).toBe(true);
  });

  test("install --yes, list, disable, enable, remove", async () => {
    const home = temp();
    const src = makePlugin();
    expect((await call(["plugin", "install", src, "--yes"], { home })).out).toContain("Installed fmt");
    expect((await call(["plugin", "install", src, "--yes"], { home })).out).toContain("Updated fmt");
    const listed = await call(["plugin", "list"], { home });
    expect(listed.out).toMatch(/fmt\s+1\.0\.0\s+enabled\s+1 command\(s\), 1 skill\(s\), hooks, MCP servers/);
    expect(listed.out).toContain(`from ${src}`);
    expect((await call(["plugin", "disable", "fmt"], { home })).out).toContain("Disabled fmt");
    expect((await call(["plugin", "list"], { home })).out).toContain("disabled");
    expect((await call(["skills"], { home })).out).not.toContain("fmt");
    expect((await call(["plugin", "enable", "fmt"], { home })).out).toContain("Enabled fmt");
    expect((await call(["skills"], { home })).out).toContain("/fmt:format");
    expect((await call(["plugin", "remove", "fmt"], { home })).out).toContain("Removed fmt");
    expect(existsSync(join(home, "plugins", "fmt"))).toBe(false);
    const missing = await call(["plugin", "remove", "fmt"], { home });
    expect(missing.code).toBe(1);
    expect(missing.err).toContain("no installed plugin named fmt");
  });

  test("bad sources and usage errors", async () => {
    const bad = await call(["plugin", "install", temp(), "--yes"]);
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("this is not a plugin");
    expect((await call(["plugin", "install", "nonsense", "--yes"])).err).toContain("not a directory");
    expect((await call(["plugin", "install"])).code).toBe(2);
    expect((await call(["plugin", "frobnicate"])).code).toBe(2);
  });

  test("teh skills and teh hooks list plugin items with their plugin as the source", async () => {
    const home = temp();
    await call(["plugin", "install", makePlugin(), "--yes"], { home });
    const skills = await call(["skills"], { home });
    expect(skills.out).toMatch(/\/format\s+plugin fmt command/);
    expect(skills.out).toMatch(/\/fmt:format\s+plugin fmt command/);
    expect(skills.out).toMatch(/\/pretty\s+plugin fmt skill/);
    const hooks = await call(["hooks"], { home });
    expect(hooks.out).toContain("PostToolUse[Edit]");
    expect(hooks.out).toContain("plugin fmt");
  });

  test("teh -p runs a plugin command by /name and /plugin:name", async () => {
    const home = temp();
    await call(["plugin", "install", makePlugin(), "--yes"], { home });
    for (const name of ["/format", "/fmt:format"]) {
      const r = await call(["-p", "--model", "fake:fake", `${name} src`], { home, turns: [say("done")] });
      expect(r.code).toBe(0);
      expect(r.fake.requests[0]?.items[0]).toEqual({
        kind: "text",
        role: "user",
        text: "Format src and nothing else.",
      });
    }
  });

  test("teh mcp starts a plugin's server through the plugin root and names its plugin", async () => {
    const home = temp();
    await call(["plugin", "install", makePlugin(), "--yes"], { home });
    const r = await call(["mcp"], { home });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/tools\s+stdio\s+plugin fmt/);
    expect(r.out).toContain("echo");
    // Disabled plugins start nothing.
    await call(["plugin", "disable", "fmt"], { home });
    expect((await call(["mcp"], { home })).out).toContain("No MCP servers configured");
  });
});
