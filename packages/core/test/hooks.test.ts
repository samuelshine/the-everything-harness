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
        PreCompact: [{ hooks: [{ type: "command", command: "x" }] }],
        Bogus: [],
        Stop: [{ matcher: "(", hooks: [{ type: "command", command: "y" }] }],
        PostToolUse: [{ hooks: [{ type: "prompt", prompt: "z" }] }],
      },
      "settings.json",
    );
    expect(config.PreToolUse).toEqual([
      { matcher: "Edit|Write", hooks: [{ command: "lint.sh", timeoutSec: 5, source: "settings.json" }] },
    ]);
    expect(config.Stop).toBeUndefined();
    expect(problems.join("\n")).toContain('unknown hook event "Bogus"');
    expect(problems.join("\n")).toContain("not a valid pattern");
    expect(problems.join("\n")).toContain('only {"type": "command"');
    // Events teh does not fire yet load without complaint.
    expect(problems.join("\n")).not.toContain("PreCompact");
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
