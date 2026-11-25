import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { countHooks, HookRunner, hookName } from "../src/hooks";
import { loadMcpConfig } from "../src/mcp/config";
import {
  classifySource,
  commitPlugin,
  installedPlugins,
  loadPlugins,
  PluginError,
  parsePluginManifest,
  pluginLabel,
  preparePlugin,
  readRegistry,
  removePlugin,
  setPluginEnabled,
} from "../src/plugins";
import { loadSettings } from "../src/settings";
import { loadSkills, parseSlash } from "../src/skills";
import { tempDir } from "./helpers";

// "${NAME}" written out, without tripping the template-string lint.
const VAR = (name: string) => `$\{${name}}`;
const ROOT = VAR("CLAUDE_PLUGIN_ROOT");

function put(root: string, rel: string, text: string | object) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), typeof text === "string" ? text : JSON.stringify(text));
}

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nDo ${name}.\n`;

// A plugin with one of everything.
function makePlugin(root: string, name = "fmt", extra: Record<string, unknown> = {}) {
  put(root, ".claude-plugin/plugin.json", {
    name,
    version: "1.2.0",
    description: "Formatting",
    author: { name: "A" },
    ...extra,
  });
  put(root, "commands/format.md", "Format $ARGUMENTS.\n");
  put(root, "skills/pretty/SKILL.md", skillMd("pretty", "Make code pretty."));
  put(root, "agents/reviewer.md", "---\nname: reviewer\n---\nReview.\n");
  put(root, "hooks/hooks.json", {
    hooks: {
      PostToolUse: [{ matcher: "Edit", hooks: [{ type: "command", command: `${ROOT}/fmt.sh` }] }],
    },
  });
  put(root, ".mcp.json", {
    mcpServers: { lint: { command: "node", args: [`${ROOT}/lint.js`], env: { KEY: `${VAR("TOKEN")}` } } },
  });
  return root;
}

const opts = (tehHome: string, cwd = tempDir("cwd-")) => ({ tehHome, cwd, env: { PATH: process.env.PATH } });

async function install(spec: string, tehHome: string, cwd?: string) {
  const p = await preparePlugin(spec, opts(tehHome, cwd));
  commitPlugin(p, tehHome);
  return p;
}

describe("manifest", () => {
  test("name is required and must be a plain name", () => {
    expect(parsePluginManifest({}).problems[0]).toContain('"name"');
    expect(parsePluginManifest({ name: "Bad Name" }).problems[0]).toContain("lowercase");
    expect(parsePluginManifest("x").problems[0]).toContain("JSON object");
  });

  test("optional fields, author as a map, and path fields", () => {
    const r = parsePluginManifest({
      name: "p",
      version: "1.0.0",
      author: { name: "Ann", email: "a@x" },
      commands: "./extra",
      skills: ["./s1", "./s2"],
      hooks: { PreToolUse: [] },
      mcpServers: "./servers.json",
    });
    expect(r.problems).toEqual([]);
    expect(r.manifest).toMatchObject({
      name: "p",
      version: "1.0.0",
      author: "Ann",
      commands: ["./extra"],
      skills: ["./s1", "./s2"],
      hooks: [{ PreToolUse: [] }],
      mcpServers: ["./servers.json"],
    });
  });

  test("paths that leave the plugin are reported and dropped", () => {
    const r = parsePluginManifest({ name: "p", commands: ["../outside", "/etc"], agents: 3 });
    expect(r.manifest?.commands).toEqual([]);
    expect(r.problems.join("\n")).toContain("must stay inside the plugin");
    expect(r.problems.join("\n")).toContain('"agents" must be a path');
  });
});

describe("classifySource", () => {
  test("directory, git URL, name@marketplace, or an error", () => {
    const dir = tempDir("src-");
    expect(classifySource(dir, "/")).toEqual({ kind: "dir", path: dir });
    expect(classifySource("https://github.com/o/r", "/")).toEqual({ kind: "git", url: "https://github.com/o/r" });
    expect(classifySource("git@github.com:o/r.git", "/")).toEqual({ kind: "git", url: "git@github.com:o/r.git" });
    expect(classifySource(`fmt@${dir}`, "/")).toEqual({
      kind: "marketplace",
      plugin: "fmt",
      marketplace: { kind: "dir", path: dir },
    });
    expect(classifySource("fmt@file:///m", "/")).toMatchObject({ kind: "marketplace", marketplace: { kind: "git" } });
    expect(() => classifySource("nonsense", "/")).toThrow(PluginError);
    expect(() => classifySource("fmt@/no/such/market", "/")).toThrow("no such marketplace");
  });
});

describe("install", () => {
  test("from a directory: summarises, copies into tehHome and records it", async () => {
    const tehHome = tempDir("teh-");
    const src = makePlugin(tempDir("plug-"));
    const p = await preparePlugin(src, opts(tehHome));
    expect(p.summary).toMatchObject({
      commands: ["format"],
      skills: ["pretty"],
      agents: ["reviewer"],
      hooks: [{ event: "PostToolUse[Edit]", what: `${ROOT}/fmt.sh` }],
      mcpServers: [{ name: "lint", what: `node ${ROOT}/lint.js` }],
    });
    // An unset TOKEN is a heads-up before installing, not a failure.
    expect(p.summary.problems).toHaveLength(1);
    expect(p.summary.problems[0]).toContain("environment variable(s) not set: TOKEN");
    // Nothing is installed until it is committed.
    expect(readRegistry(tehHome).plugins).toEqual({});
    expect(commitPlugin(p, tehHome)).toEqual({ replaced: false });
    expect(existsSync(join(tehHome, "plugins", "fmt", "commands", "format.md"))).toBe(true);
    expect(readRegistry(tehHome).plugins.fmt).toMatchObject({ source: src, enabled: true });
    // Staging is gone, and installing again replaces.
    expect(commitPlugin(await preparePlugin(src, opts(tehHome)), tehHome)).toEqual({ replaced: true });
  });

  test("discarding removes the staging folder", async () => {
    const tehHome = tempDir("teh-");
    const p = await preparePlugin(makePlugin(tempDir("plug-")), opts(tehHome));
    p.discard();
    expect(existsSync(p.root)).toBe(false);
  });

  test("a folder without a manifest, or with a bad one, is refused", async () => {
    const tehHome = tempDir("teh-");
    const empty = tempDir("plug-");
    await expect(preparePlugin(empty, opts(tehHome))).rejects.toThrow("this is not a plugin");
    put(empty, ".claude-plugin/plugin.json", "{ nope");
    await expect(preparePlugin(empty, opts(tehHome))).rejects.toThrow("not valid JSON");
  });

  test("from a local git repository over file://", async () => {
    const tehHome = tempDir("teh-");
    const repo = makePlugin(tempDir("repo-"), "gitfmt");
    const git = (...a: string[]) => {
      const r = Bun.spawnSync(["git", ...a], {
        cwd: repo,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
      expect(r.exitCode).toBe(0);
    };
    git("init", "-q");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    const p = await install(`file://${repo}`, tehHome);
    expect(p.name).toBe("gitfmt");
    expect(existsSync(join(tehHome, "plugins", "gitfmt", "commands", "format.md"))).toBe(true);
    expect(existsSync(join(tehHome, "plugins", "gitfmt", ".git"))).toBe(false);
    expect(readRegistry(tehHome).plugins.gitfmt?.source).toBe(`file://${repo}`);
  });

  test("a failing clone reports git's reason and leaves nothing behind", async () => {
    const tehHome = tempDir("teh-");
    await expect(preparePlugin(`file://${tempDir("nothing-")}`, opts(tehHome))).rejects.toThrow("git clone");
    expect(readRegistry(tehHome).plugins).toEqual({});
  });

  test("from a marketplace folder, resolving the entry's source against it", async () => {
    const tehHome = tempDir("teh-");
    const market = tempDir("market-");
    makePlugin(join(market, "plugins", "fmt"));
    makePlugin(join(market, "plugins", "other"), "other");
    put(market, ".claude-plugin/marketplace.json", {
      name: "m",
      plugins: [
        { name: "fmt", source: "./plugins/fmt", description: "x" },
        { name: "other", source: "./plugins/other" },
        { name: "escape", source: "../elsewhere" },
        { name: "mismatch", source: "./plugins/other" },
        { name: "remote", source: { source: "github", repo: "owner/repo" } },
      ],
    });
    const p = await install(`fmt@${market}`, tehHome);
    expect(p.marketplace).toBe(market);
    expect(readRegistry(tehHome).plugins.fmt).toMatchObject({ source: `fmt@${market}`, marketplace: market });
    await expect(preparePlugin(`missing@${market}`, opts(tehHome))).rejects.toThrow("lists fmt, other");
    await expect(preparePlugin(`escape@${market}`, opts(tehHome))).rejects.toThrow("inside the marketplace");
    await expect(preparePlugin(`mismatch@${market}`, opts(tehHome))).rejects.toThrow("is named other");
    // A github entry is cloned from github's URL; the fake git records it and fails.
    const urls: string[] = [];
    const git = async (args: string[]) => {
      urls.push(args.at(-2) ?? "");
      return { code: 1, stderr: "offline" };
    };
    await expect(preparePlugin(`remote@${market}`, { ...opts(tehHome), git })).rejects.toThrow("offline");
    expect(urls).toEqual(["https://github.com/owner/repo.git"]);
  });

  test("from a marketplace in a git repository", async () => {
    const tehHome = tempDir("teh-");
    const market = tempDir("market-");
    makePlugin(join(market, "fmt"));
    put(market, ".claude-plugin/marketplace.json", { name: "m", plugins: [{ name: "fmt", source: "./fmt" }] });
    const run = (...a: string[]) =>
      Bun.spawnSync(["git", ...a], {
        cwd: market,
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@t",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@t",
        },
      });
    run("init", "-q");
    run("add", ".");
    run("commit", "-q", "-m", "init");
    const p = await install(`fmt@file://${market}`, tehHome);
    expect(p.name).toBe("fmt");
    expect(existsSync(join(tehHome, "plugins", "fmt", "commands", "format.md"))).toBe(true);
    // The marketplace checkout was removed.
    expect(installedPlugins(tehHome).plugins).toHaveLength(1);
    expect(Bun.spawnSync(["ls", "-a", join(tehHome, "plugins")]).stdout.toString()).not.toContain(".staging");
  });
});

describe("enable, disable and remove", () => {
  test("a disabled plugin loads nothing; enabling brings it back; remove deletes it", async () => {
    const tehHome = tempDir("teh-");
    const home = tempDir("home-");
    await install(makePlugin(tempDir("plug-")), tehHome);
    const names = () => loadSkills(tehHome, tempDir("proj-"), home).skills.map((s) => s.name);
    expect(names()).toContain("pretty");
    expect(setPluginEnabled(tehHome, "fmt", false)).toBe(true);
    expect(names()).toEqual([]);
    expect(countHooks(loadSettings(tehHome, tempDir("proj-"), home).hooks.user)).toBe(0);
    expect(loadPlugins(tehHome).mcpServers).toEqual([]);
    expect(installedPlugins(tehHome).plugins[0]).toMatchObject({ name: "fmt", enabled: false });
    setPluginEnabled(tehHome, "fmt", true);
    expect(names()).toContain("pretty");
    expect(removePlugin(tehHome, "fmt")).toBe(true);
    expect(existsSync(join(tehHome, "plugins", "fmt"))).toBe(false);
    expect(names()).toEqual([]);
    expect(setPluginEnabled(tehHome, "fmt", true)).toBe(false);
    expect(removePlugin(tehHome, "fmt")).toBe(false);
  });
});

describe("loading", () => {
  test("skills and commands: /name and /plugin:name, never shadowing the user's own", async () => {
    const tehHome = tempDir("teh-");
    const home = tempDir("home-");
    const project = tempDir("proj-");
    put(tehHome, "commands/format.md", "The user's own format.\n");
    put(project, ".claude/skills/pretty/SKILL.md", skillMd("pretty", "A repo's pretty."));
    await install(makePlugin(tempDir("plug-")), tehHome);
    const { skills, problems } = loadSkills(tehHome, project, home);
    expect(problems).toEqual([]);
    const by = Object.fromEntries(skills.map((s) => [s.name, s]));
    // The user's /format wins the bare name; the plugin's is reachable by its prefix.
    expect(by.format?.source).toBe("user");
    expect(by["fmt:format"]).toMatchObject({ source: "plugin", plugin: "fmt", kind: "command", userInvocable: true });
    // Plugins come before the project: a repo cannot shadow a plugin's skill.
    expect(by.pretty).toMatchObject({ source: "plugin", plugin: "fmt", modelInvocable: true });
    expect(by["fmt:pretty"]).toMatchObject({ source: "plugin", modelInvocable: false, userInvocable: true });
    expect(parseSlash("/fmt:format src")).toEqual({ name: "fmt:format", args: "src" });
  });

  test("when the bare name is free the model sees the skill once", async () => {
    const tehHome = tempDir("teh-");
    await install(makePlugin(tempDir("plug-")), tehHome);
    const { skills } = loadSkills(tehHome, tempDir("proj-"), tempDir("home-"));
    expect(skills.filter((s) => s.modelInvocable).map((s) => s.name)).toEqual(["pretty"]);
    expect(skills.map((s) => s.name)).toEqual(["fmt:format", "fmt:pretty", "format", "pretty"]);
  });

  test("manifest paths add to the default folders", async () => {
    const tehHome = tempDir("teh-");
    const src = makePlugin(tempDir("plug-"), "multi", { commands: ["./more", "./one.md"], skills: "./extra-skills" });
    put(src, "more/a.md", "A.\n");
    put(src, "one.md", "One.\n");
    put(src, "extra-skills/s/SKILL.md", skillMd("s", "S."));
    await install(src, tehHome);
    const names = loadSkills(tehHome, tempDir("proj-"), tempDir("home-")).skills.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["a", "one", "s", "format", "pretty"]));
  });

  test("hooks: source is the plugin's file, the plugin root is substituted and exported", async () => {
    const tehHome = tempDir("teh-");
    await install(makePlugin(tempDir("plug-")), tehHome);
    const root = join(tehHome, "plugins", "fmt");
    const settings = loadSettings(tehHome, tempDir("proj-"), tempDir("home-"));
    const hook = settings.hooks.user.PostToolUse?.[0]?.hooks[0];
    expect(hook).toMatchObject({ command: `${root}/fmt.sh`, source: join(root, "hooks", "hooks.json") });
    expect(hook && "env" in hook ? hook.env : undefined).toEqual({ CLAUDE_PLUGIN_ROOT: root, TEH_PLUGIN_ROOT: root });
    expect(hook && hookName(hook)).toStartWith(root.slice(0, 20));
    expect(pluginLabel(tehHome, hook?.source ?? "")).toBe("plugin fmt");
    expect(pluginLabel(tehHome, "/elsewhere/hooks.json")).toBeUndefined();
  });

  test("a plugin hook runs with the plugin root in its environment", async () => {
    const tehHome = tempDir("teh-");
    const src = tempDir("plug-");
    put(src, ".claude-plugin/plugin.json", { name: "envy" });
    put(src, "hooks/hooks.json", {
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: `echo "$CLAUDE_PLUGIN_ROOT|$TEH_PLUGIN_ROOT|${VAR("TEH_PLUGIN_ROOT")}"` },
          ],
        },
      ],
    });
    await install(src, tehHome);
    const root = join(tehHome, "plugins", "envy");
    const runner = new HookRunner({
      config: loadPlugins(tehHome).hooks,
      cwd: root,
      projectRoot: root,
      sessionId: "s",
      transcriptPath: "/t",
      env: { PATH: process.env.PATH },
    });
    const out = await runner.run({ hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(out.context).toEqual([`${root}|${root}|${root}`]);
  });

  test("a bad hooks file is reported; the rest of the plugin still loads", async () => {
    const tehHome = tempDir("teh-");
    const src = makePlugin(tempDir("plug-"));
    put(src, "hooks/hooks.json", "{ nope");
    await install(src, tehHome);
    const set = loadPlugins(tehHome, { TOKEN: "x" });
    expect(set.problems.map((p) => p.area)).toEqual(["hooks"]);
    expect(set.mcpServers).toHaveLength(1);
    const settings = loadSettings(tehHome, tempDir("proj-"), tempDir("home-"));
    expect(settings.problems[0]?.message).toContain("not valid JSON");
  });

  test("MCP servers: root substituted and exported, user scope, overridden by the user's own", async () => {
    const tehHome = tempDir("teh-");
    await install(makePlugin(tempDir("plug-")), tehHome);
    const root = join(tehHome, "plugins", "fmt");
    const set = loadPlugins(tehHome, { TOKEN: "t0k" });
    expect(set.problems).toEqual([]);
    expect(set.mcpServers).toEqual([
      {
        name: "lint",
        scope: "user",
        source: join(root, ".mcp.json"),
        transport: "stdio",
        command: "node",
        args: [`${root}/lint.js`],
        env: { CLAUDE_PLUGIN_ROOT: root, TEH_PLUGIN_ROOT: root, KEY: "t0k" },
      },
    ]);
    // An unset TOKEN is a problem, as for any other config.
    expect(loadPlugins(tehHome, {}).problems[0]).toMatchObject({ area: "mcp" });
    // Merged through loadMcpConfig; the user's server of the same name wins.
    put(tehHome, "mcp.json", { mcpServers: { lint: { command: "mine" } } });
    const cfg = loadMcpConfig({ tehHome, projectRoot: tempDir("proj-"), cwd: "/", env: {}, plugin: set.mcpServers });
    expect(cfg.servers.map((s) => [s.name, s.transport === "stdio" ? s.command : ""])).toEqual([["lint", "mine"]]);
  });

  test("a bare server map in .mcp.json and a hook map without a wrapper both work", async () => {
    const tehHome = tempDir("teh-");
    const src = tempDir("plug-");
    put(src, ".claude-plugin/plugin.json", {
      name: "bare",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
    });
    put(src, ".mcp.json", { web: { type: "http", url: "https://x.example/mcp" } });
    await install(src, tehHome);
    const set = loadPlugins(tehHome);
    expect(set.mcpServers.map((s) => s.name)).toEqual(["web"]);
    expect(countHooks(set.hooks)).toBe(1);
  });

  test("a plugin whose folder vanished is reported, not fatal", async () => {
    const tehHome = tempDir("teh-");
    await install(makePlugin(tempDir("plug-")), tehHome);
    Bun.spawnSync(["rm", "-rf", join(tehHome, "plugins", "fmt")]);
    const set = loadPlugins(tehHome);
    expect(set.problems[0]?.message).toContain("folder is missing");
    expect(loadSkills(tehHome, tempDir("proj-"), tempDir("home-")).skills).toEqual([]);
  });

  test("an unreadable registry is reported and treated as empty", () => {
    const tehHome = tempDir("teh-");
    put(tehHome, "plugins/installed.json", "{ nope");
    expect(readRegistry(tehHome).problem).toContain("not valid JSON");
    expect(readFileSync(join(tehHome, "plugins", "installed.json"), "utf8")).toBe("{ nope");
    expect(loadPlugins(tehHome).plugins).toEqual([]);
  });
});
