import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, type AgentOptions, runAgent } from "../src/agent";
import { type HookConfig, HookRunner, parseHooks } from "../src/hooks";
import { parseRules } from "../src/permissions";
import { callTool, FakeProvider, type FakeTurn, say } from "../src/providers/fake";
import { loadSession, type SessionEvent, SessionLog } from "../src/session";
import { builtinTools } from "../src/tools";
import { tempDir } from "./helpers";

const posix = process.platform !== "win32";

// A hook command that runs a small Bun script, so tests behave the same on every OS.
function script(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(path, `const input = JSON.parse(await Bun.stdin.text());\n${body}\n`);
  return `"${process.execPath}" "${path}"`;
}

const hook = (event: string, command: string, matcher?: string): HookConfig =>
  parseHooks({ [event]: [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command }] }] }, "test").config;

function setup(turns: FakeTurn[], config: HookConfig, opts: Partial<AgentOptions> = {}) {
  const cwd = tempDir();
  const provider = new FakeProvider(turns);
  const events: AgentEvent[] = [];
  const home = tempDir("teh-home-");
  const session = new SessionLog(home, cwd, "local:test");
  const hooks = new HookRunner({
    config,
    cwd,
    projectRoot: cwd,
    sessionId: session.id,
    transcriptPath: session.path,
    env: { PATH: process.env.PATH },
  });
  const go = () =>
    runAgent({
      provider,
      model: "fake",
      prompt: "do the thing",
      cwd,
      tools: builtinTools,
      permissions: { mode: "default", allow: [], deny: [] },
      ask: async () => false,
      session,
      hooks,
      onEvent: (e) => events.push(e),
      ...opts,
    });
  const log = () =>
    readFileSync(session.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionEvent);
  return { cwd, home, provider, events, go, log, session };
}

describe("parseHooks", () => {
  test("reads Claude Code's format and reports problems", () => {
    const { config, problems } = parseHooks(
      {
        PreToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: "lint.sh", timeout: 5 }] }],
        SubagentStop: [{ hooks: [{ type: "command", command: "x" }] }],
        Bogus: [],
        Stop: [{ matcher: "(", hooks: [{ type: "command", command: "y" }] }],
        PostToolUse: [{ hooks: [{ type: "prompt", prompt: "z" }] }],
        SessionStart: [{ hooks: [{ type: "prompt", prompt: "nope" }] }],
        Notification: [{ hooks: [{ type: "http", url: "ftp://x" }] }],
      },
      "settings.json",
    );
    expect(config.PreToolUse).toEqual([
      {
        matcher: "Edit|Write",
        hooks: [{ type: "command", command: "lint.sh", timeoutSec: 5, source: "settings.json" }],
      },
    ]);
    expect(config.Stop).toBeUndefined();
    expect(problems.join("\n")).toContain('unknown hook event "Bogus"');
    expect(problems.join("\n")).toContain("not a valid pattern");
    const all = problems.join("\n");
    expect(all).toContain("hooks.SessionStart: prompt hooks work on");
    expect(all).toContain("hooks.Notification: each hook needs");
    expect(config.PostToolUse?.[0]?.hooks[0]).toMatchObject({ type: "prompt", prompt: "z" });
    expect(config.SessionStart).toBeUndefined();
    expect(config.SubagentStop).toBeDefined();
    expect(all).not.toContain("hooks.SubagentStop");
  });

  test("an unknown hook type and a bad http url are problems", () => {
    const { config, problems } = parseHooks(
      {
        PreToolUse: [
          {
            hooks: [
              { type: "wasm", command: "x" },
              { type: "http", url: "not a url" },
              {
                type: "http",
                url: "https://example.test/h",
                headers: { A: "b", C: 1 },
                allowedEnvVars: ["T", 5],
                timeout: 3,
              },
            ],
          },
        ],
      },
      "s",
    );
    expect(problems).toHaveLength(2);
    expect(config.PreToolUse?.[0]?.hooks).toEqual([
      {
        type: "http",
        url: "https://example.test/h",
        source: "s",
        headers: { A: "b" },
        allowedEnvVars: ["T"],
        timeoutSec: 3,
      },
    ]);
  });
});

describe("HookRunner", () => {
  test("passes the event as JSON on stdin, with the project dir in the environment", async () => {
    const dir = tempDir();
    const out = join(dir, "seen.json");
    const cmd = script(
      dir,
      "record",
      `await Bun.write(${JSON.stringify(out)}, JSON.stringify({ input, dir: process.env.CLAUDE_PROJECT_DIR, teh: process.env.TEH_PROJECT_DIR }));`,
    );
    const runner = new HookRunner({
      config: hook("PreToolUse", cmd, "Bash"),
      cwd: dir,
      projectRoot: dir,
      sessionId: "s1",
      transcriptPath: "/t.jsonl",
    });
    const skipped = await runner.run({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: {} }, "Edit");
    expect(skipped.ran).toBe(0);
    expect(existsSync(out)).toBe(false);
    const o = await runner.run(
      { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
      "Bash",
    );
    expect(o.ran).toBe(1);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual({
      input: {
        session_id: "s1",
        transcript_path: "/t.jsonl",
        cwd: dir,
        hook_event_name: "PreToolUse",
        tool_name: "Bash",
        tool_input: { command: "ls" },
      },
      dir,
      teh: dir,
    });
  });

  test("exit 2 blocks with stderr; other failures only warn; timeouts are reported", async () => {
    const dir = tempDir();
    const run = (body: string, timeout?: number) =>
      new HookRunner({
        config: parseHooks(
          {
            PreToolUse: [
              {
                hooks: [
                  { type: "command", command: script(dir, `h${Math.random()}`, body), ...(timeout ? { timeout } : {}) },
                ],
              },
            ],
          },
          "t",
        ).config,
        cwd: dir,
        projectRoot: dir,
        sessionId: "s",
        transcriptPath: "t",
      }).run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "Bash");
    const blocked = await run(`console.error("no rm please"); process.exit(2);`);
    expect(blocked.block).toBe("no rm please");
    expect(blocked.permission?.decision).toBe("deny");
    const failed = await run(`console.error("oops"); process.exit(1);`);
    expect(failed.block).toBeUndefined();
    expect(failed.messages[0]).toContain("PreToolUse hook failed (exit 1)");
    const slow = await run(`await Bun.sleep(5000);`, 0.2);
    expect(slow.messages[0]).toContain("timed out");
  });

  test("JSON output: deny beats ask beats allow, plus systemMessage and continue false", async () => {
    const dir = tempDir();
    const say = (o: unknown) => script(dir, `j${Math.random()}`, `console.log(${JSON.stringify(JSON.stringify(o))});`);
    const runner = new HookRunner({
      config: parseHooks(
        {
          PreToolUse: [
            {
              hooks: [
                {
                  type: "command",
                  command: say({
                    hookSpecificOutput: { permissionDecision: "allow", permissionDecisionReason: "fine" },
                  }),
                },
                {
                  type: "command",
                  command: say({
                    hookSpecificOutput: { permissionDecision: "ask", permissionDecisionReason: "check" },
                  }),
                },
                { type: "command", command: say({ systemMessage: "heads up", continue: false, stopReason: "enough" }) },
              ],
            },
          ],
        },
        "t",
      ).config,
      cwd: dir,
      projectRoot: dir,
      sessionId: "s",
      transcriptPath: "t",
    });
    const o = await runner.run({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: {} }, "Bash");
    expect(o.permission).toEqual({ decision: "ask", reason: "check" });
    expect(o.messages).toEqual(["heads up"]);
    expect(o.halt).toBe("enough");
  });
});

describe("runAgent with hooks", () => {
  test("a PreToolUse hook blocks a tool and the model sees why", async () => {
    const dir = tempDir();
    const cmd = script(dir, "guard", `console.error("use the formatter instead"); process.exit(2);`);
    const { events, provider, go, cwd } = setup(
      [callTool("Bash", { command: "echo hi > out.txt" }), say("ok")],
      hook("PreToolUse", cmd, "Bash"),
      { permissions: { mode: "bypassPermissions", allow: [], deny: [] } },
    );
    await go();
    expect(existsSync(join(cwd, "out.txt"))).toBe(false);
    const result = provider.requests[1]?.items.at(-1);
    expect(result).toMatchObject({ kind: "tool_result", isError: true });
    expect((result as { content: string }).content).toContain(
      "Blocked by a PreToolUse hook: use the formatter instead",
    );
    expect(events.some((e) => e.type === "approval" && e.behavior === "deny")).toBe(true);
  });

  test("a PreToolUse hook can allow what would ask, but never what a deny rule blocks", async () => {
    const dir = tempDir();
    const allow = script(
      dir,
      "allow",
      `console.log(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", permissionDecisionReason: "trusted script" } }));`,
    );
    const a = setup([callTool("Write", { file_path: "a.txt", content: "x" }), say("ok")], hook("PreToolUse", allow));
    await a.go();
    expect(readFileSync(join(a.cwd, "a.txt"), "utf8")).toBe("x");
    expect(a.events).toContainEqual(
      expect.objectContaining({
        type: "approval",
        behavior: "allow",
        reason: "allowed by PreToolUse hook: trusted script",
      }),
    );

    const b = setup([callTool("Write", { file_path: "a.txt", content: "x" }), say("ok")], hook("PreToolUse", allow), {
      permissions: { mode: "default", allow: [], deny: parseRules(["Write"]) },
    });
    await b.go();
    expect(existsSync(join(b.cwd, "a.txt"))).toBe(false);
  });

  test("a PreToolUse hook can rewrite the input before it is checked and run", async () => {
    const dir = tempDir();
    const cmd = script(
      dir,
      "rewrite",
      `console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { ...input.tool_input, file_path: "safe.txt" } } }));`,
    );
    const { cwd, go, log } = setup(
      [callTool("Write", { file_path: "a.txt", content: "x" }), say("ok")],
      hook("PreToolUse", cmd, "Write"),
    );
    await go();
    expect(existsSync(join(cwd, "a.txt"))).toBe(false);
    expect(readFileSync(join(cwd, "safe.txt"), "utf8")).toBe("x");
    expect(log().find((e) => e.type === "tool_call")?.data).toMatchObject({ hookInput: { file_path: "safe.txt" } });
  });

  test("PostToolUse feedback reaches the model with the tool result", async () => {
    const dir = tempDir();
    const cmd = script(
      dir,
      "lint",
      `console.log(JSON.stringify({ decision: "block", reason: "lint: missing semicolon in " + input.tool_input.file_path }));`,
    );
    const { provider, go } = setup(
      [callTool("Write", { file_path: "a.js", content: "x" }), say("ok")],
      hook("PostToolUse", cmd, "Edit|Write"),
      { permissions: { mode: "acceptEdits", allow: [], deny: [] } },
    );
    await go();
    const result = provider.requests[1]?.items.at(-1) as { content: string; isError: boolean };
    expect(result.content).toContain("PostToolUse hook feedback:\nlint: missing semicolon in a.js");
    expect(result.isError).toBe(true);
  });

  test("UserPromptSubmit can add context or block the prompt", async () => {
    const dir = tempDir();
    const ctx = script(dir, "ctx", `console.log("branch: main");`);
    const a = setup([say("ok")], hook("UserPromptSubmit", ctx));
    await a.go();
    expect(a.provider.requests[0]?.items).toEqual([
      { kind: "text", role: "user", text: "do the thing" },
      { kind: "text", role: "user", text: "UserPromptSubmit hook: branch: main" },
    ]);
    // The added context survives a resume.
    expect(loadSession(a.session.path).items[1]).toEqual({
      kind: "text",
      role: "user",
      text: "UserPromptSubmit hook: branch: main",
    });

    const block = script(dir, "block", `console.error("no secrets in prompts"); process.exit(2);`);
    const b = setup([], hook("UserPromptSubmit", block));
    const res = await b.go();
    expect(res.stopReason).toBe("hook_blocked");
    expect(b.provider.requests).toHaveLength(0);
    expect(b.events).toContainEqual({
      type: "hook",
      event: "UserPromptSubmit",
      message: "prompt blocked: no secrets in prompts",
    });
    expect(b.log().some((e) => e.type === "user_message")).toBe(false);
  });

  test("a Stop hook sends the model back once, then lets it stop", async () => {
    const dir = tempDir();
    const cmd = script(
      dir,
      "stop",
      `if (!input.stop_hook_active) { console.error("run the tests first"); process.exit(2); }`,
    );
    const { provider, go } = setup([say("done"), say("tests pass, done")], hook("Stop", cmd));
    const res = await go();
    expect(res).toMatchObject({ result: "tests pass, done", stopReason: "end", turns: 2 });
    expect(provider.requests[1]?.items.at(-1)).toEqual({
      kind: "text",
      role: "user",
      text: "Stop hook: run the tests first",
    });
  });

  test("SessionStart context comes first; continue false stops the run", async () => {
    const dir = tempDir();
    const ctx = script(dir, "start", `console.log("source=" + input.source);`);
    const a = setup([say("ok")], hook("SessionStart", ctx, "startup"), { hookSessionStart: "startup" });
    await a.go();
    expect(a.provider.requests[0]?.items[0]).toEqual({
      kind: "text",
      role: "user",
      text: "SessionStart hook: source=startup",
    });

    const halt = script(
      dir,
      "halt",
      `console.log(JSON.stringify({ continue: false, stopReason: "build is broken" }));`,
    );
    const b = setup(
      [callTool("Read", { file_path: "x" }), callTool("Read", { file_path: "y" })],
      hook("PostToolUse", halt),
    );
    const res = await b.go();
    expect(res.stopReason).toBe("hook_stopped");
    expect(b.provider.requests).toHaveLength(1);
    expect(b.events).toContainEqual({ type: "hook", event: "PostToolUse", message: "stopped: build is broken" });
  });

  test.if(posix)("plain shell commands work as hooks", async () => {
    const { provider, go } = setup([say("ok")], hook("UserPromptSubmit", "echo from-shell"));
    await go();
    expect(provider.requests[0]?.items[1]).toEqual({
      kind: "text",
      role: "user",
      text: "UserPromptSubmit hook: from-shell",
    });
  });
});

const baseOpts = (config: HookConfig, extra: Partial<ConstructorParameters<typeof HookRunner>[0]> = {}) => ({
  config,
  cwd: "/",
  projectRoot: "/",
  sessionId: "s",
  transcriptPath: "/t",
  ...extra,
});
const pre = { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } } as const;

describe("http hooks", () => {
  const httpHook = (url: string, extra: Record<string, unknown> = {}) =>
    parseHooks({ PreToolUse: [{ hooks: [{ type: "http", url, ...extra }] }] }, "test").config;

  test("a 2xx JSON reply is read like a command hook's stdout; the event is the body", async () => {
    let seen: { body?: { tool_name?: string; session_id?: string }; type?: string | null } = {};
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        seen = {
          body: (await req.json()) as { tool_name?: string; session_id?: string },
          type: req.headers.get("content-type"),
        };
        return Response.json({
          hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "no ls here" },
        });
      },
    });
    try {
      const o = await new HookRunner(baseOpts(httpHook(`http://localhost:${server.port}/`))).run(pre, "Bash");
      expect(o.block).toBe("no ls here");
      expect(o.permission).toEqual({ decision: "deny", reason: "no ls here" });
      expect(seen.type).toBe("application/json");
      expect(seen.body).toMatchObject({ tool_name: "Bash", session_id: "s" });
    } finally {
      await server.stop(true);
    }
  });

  test("a non-2xx reply is a non-blocking message", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("boom", { status: 500 }) });
    try {
      const o = await new HookRunner(baseOpts(httpHook(`http://localhost:${server.port}/`))).run(pre, "Bash");
      expect(o.block).toBeUndefined();
      expect(o.messages.join("\n")).toContain("HTTP 500: boom");
    } finally {
      await server.stop(true);
    }
  });

  test("a slow server times out without blocking", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => new Promise<Response>((r) => setTimeout(() => r(new Response("{}")), 3000)),
    });
    try {
      const o = await new HookRunner(baseOpts(httpHook(`http://localhost:${server.port}/`, { timeout: 0.2 }))).run(
        pre,
        "Bash",
      );
      expect(o.block).toBeUndefined();
      expect(o.messages.join("\n")).toContain("timed out");
    } finally {
      await server.stop(true);
    }
  });

  test("headers substitute only the allowed environment variables", async () => {
    let auth: string | null = null;
    let other: string | null = null;
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        auth = req.headers.get("authorization");
        other = req.headers.get("x-other");
        return new Response("{}");
      },
    });
    try {
      const config = httpHook(`http://localhost:${server.port}/`, {
        // biome-ignore lint/suspicious/noTemplateCurlyInString: a literal hook header, not a template
        headers: { Authorization: "Bearer $TOKEN", "X-Other": "a${SECRET}b" },
        allowedEnvVars: ["TOKEN"],
      });
      await new HookRunner(baseOpts(config, { env: { TOKEN: "t0k", SECRET: "s3cret" } })).run(pre, "Bash");
      expect(auth as string | null).toBe("Bearer t0k");
      expect(other as string | null).toBe("ab");
    } finally {
      await server.stop(true);
    }
  });
});

describe("prompt hooks", () => {
  const promptHook = (event = "PreToolUse", extra: Record<string, unknown> = {}) =>
    parseHooks({ [event]: [{ hooks: [{ type: "prompt", prompt: "Is this safe? $ARGUMENTS", ...extra }] }] }, "t")
      .config;
  const judging = (reply: string, seen: { ask?: string; model?: string | undefined }[] = []) =>
    new HookRunner(
      baseOpts(promptHook("PreToolUse", { model: "ollama:tiny" }), {
        judge: async (ask, model) => {
          seen.push({ ask, model });
          return reply;
        },
      }),
    );

  test("ok true lets it go ahead; the event and the hook's model reach the judge", async () => {
    const seen: { ask?: string; model?: string | undefined }[] = [];
    const o = await judging('Sure. {"ok": true}', seen).run(pre, "Bash");
    expect(o.block).toBeUndefined();
    expect(o.messages).toEqual([]);
    expect(o.ran).toBe(1);
    expect(seen[0]?.model).toBe("ollama:tiny");
    expect(seen[0]?.ask).toContain("Is this safe?");
    expect(seen[0]?.ask).toContain('"tool_name":"Bash"');
  });

  test("ok false blocks with the reason", async () => {
    const o = await judging('{"ok": false, "reason": "it deletes things"}').run(pre, "Bash");
    expect(o.block).toBe("it deletes things");
    expect(o.permission).toEqual({ decision: "deny", reason: "it deletes things" });
  });

  test("an unparseable reply is a non-blocking message", async () => {
    const o = await judging("I think it is fine.").run(pre, "Bash");
    expect(o.block).toBeUndefined();
    expect(o.messages.join("\n")).toContain("not {");
    const bad = await judging("{ok: maybe}").run(pre, "Bash");
    expect(bad.block).toBeUndefined();
    expect(bad.messages).toHaveLength(1);
  });

  test("without a judge it says so and does not block", async () => {
    const o = await new HookRunner(baseOpts(promptHook())).run(pre, "Bash");
    expect(o.block).toBeUndefined();
    expect(o.messages.join("\n")).toContain("prompt hooks need a model");
  });
});

describe("HookRunner.only", () => {
  test("keeps just the named events", () => {
    const config = {
      ...hook("Stop", "echo a"),
      ...hook("SubagentStop", "echo b"),
      ...hook("PreToolUse", "echo c"),
    };
    const sub = new HookRunner(baseOpts(config)).only(["SubagentStop"]);
    expect(sub.has("SubagentStop")).toBe(true);
    expect(sub.has("Stop")).toBe(false);
    expect(sub.has("PreToolUse")).toBe(false);
  });
});

describe("SubagentStop", () => {
  test("a block sends the explore subagent back for one more turn; the parent's Stop does not fire for it", async () => {
    const dir = tempDir();
    const subLog = join(dir, "sub.log");
    const stopLog = join(dir, "stop.log");
    const subHook = script(
      dir,
      "substop",
      `const fs = require("node:fs"); fs.appendFileSync(${JSON.stringify(subLog)}, JSON.stringify(input) + "\\n");
if (!input.stop_hook_active) { console.log(JSON.stringify({ decision: "block", reason: "cite file paths" })); }`,
    );
    const stopHook = script(
      dir,
      "stop",
      `require("node:fs").appendFileSync(${JSON.stringify(stopLog)}, input.stop_hook_active + "\\n");`,
    );
    const config = { ...hook("SubagentStop", subHook), ...hook("Stop", stopHook) };
    const explorer = new FakeProvider([say("first report"), say("report with a.txt:1")]);
    const { provider, go } = setup([callTool("Task", { description: "find", prompt: "Where?" }), say("done")], config, {
      explore: { provider: explorer, model: "small", label: "ollama:small" },
    });
    const res = await go();
    expect(res.result).toBe("done");
    // The subagent got exactly one more turn, with the hook's reason.
    expect(explorer.requests).toHaveLength(2);
    expect(explorer.requests[1]?.items.at(-1)).toEqual({
      kind: "text",
      role: "user",
      text: "SubagentStop hook: cite file paths",
    });
    const sub = readFileSync(subLog, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    // It fires once: after the extra turn the subagent stops without asking again.
    expect(sub).toHaveLength(1);
    expect(sub[0]).toMatchObject({
      hook_event_name: "SubagentStop",
      stop_hook_active: false,
      agent_type: "explore",
      last_assistant_message: "first report",
    });
    // The parent saw the second report, and its own Stop hook ran once, for the parent only.
    const result = provider.requests[1]?.items.at(-1) as { content: string };
    expect(result.content).toStartWith("report with a.txt:1");
    expect(readFileSync(stopLog, "utf8").trim().split("\n")).toEqual(["false"]);
  });

  test("a second block does not loop: the subagent stops after one extra turn", async () => {
    const dir = tempDir();
    const always = script(dir, "always", `console.error("again"); process.exit(2);`);
    const explorer = new FakeProvider([say("one"), say("two"), say("three")]);
    const { go } = setup(
      [callTool("Task", { description: "d", prompt: "p" }), say("done")],
      hook("SubagentStop", always),
      {
        explore: { provider: explorer, model: "small", label: "ollama:small" },
      },
    );
    await go();
    expect(explorer.requests).toHaveLength(2);
  });
});
