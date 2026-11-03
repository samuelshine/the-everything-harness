import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, type AgentOptions, runAgent } from "../src/agent";
import { callTool, FakeProvider, type FakeTurn, say } from "../src/providers/fake";
import { type SessionEvent, SessionLog } from "../src/session";
import { builtinTools } from "../src/tools";
import { tempDir } from "./helpers";

function setup(turns: FakeTurn[], opts: Partial<AgentOptions> = {}) {
  const cwd = tempDir();
  const provider = new FakeProvider(turns);
  const events: AgentEvent[] = [];
  const session = new SessionLog(tempDir("teh-home-"), cwd, "local:test");
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
      onEvent: (e) => events.push(e),
      ...opts,
    });
  const log = () =>
    readFileSync(session.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as SessionEvent);
  return { cwd, provider, events, go, log };
}

describe("runAgent", () => {
  test("answers directly when no tools are needed", async () => {
    const { go } = setup([say("hello")]);
    const res = await go();
    expect(res).toMatchObject({ result: "hello", stopReason: "end", turns: 1 });
  });

  test("runs a read, feeds the result back, then answers", async () => {
    const { cwd, provider, go } = setup([callTool("Read", { file_path: "notes.txt" }), say("it says hi")]);
    writeFileSync(join(cwd, "notes.txt"), "hi");
    const res = await go();
    expect(res.result).toBe("it says hi");
    const second = provider.requests[1];
    expect(second?.items.at(-1)).toEqual({
      kind: "tool_result",
      callId: "call_Read",
      name: "Read",
      content: "     1\thi",
      isError: false,
    });
  });

  test("headless default mode denies an edit and tells the model", async () => {
    const { cwd, events, provider, go } = setup([
      callTool("Read", { file_path: "a.txt" }),
      callTool("Edit", { file_path: "a.txt", old_string: "x", new_string: "y" }),
      say("could not edit"),
    ]);
    writeFileSync(join(cwd, "a.txt"), "x");
    await go();
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("x");
    expect(events).toContainEqual(expect.objectContaining({ type: "approval", name: "Edit", behavior: "deny" }));
    const result = provider.requests[2]?.items.at(-1);
    expect(result).toMatchObject({ kind: "tool_result", isError: true });
    expect((result as { content: string }).content).toStartWith("Permission denied: Edit a.txt");
  });

  test("acceptEdits lets the edit through", async () => {
    const { cwd, go } = setup(
      [
        callTool("Read", { file_path: "a.txt" }),
        callTool("Edit", { file_path: "a.txt", old_string: "x", new_string: "y" }),
        say("done"),
      ],
      { permissions: { mode: "acceptEdits", allow: [], deny: [] } },
    );
    writeFileSync(join(cwd, "a.txt"), "x");
    await go();
    expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("y");
  });

  test("an approving asker allows a command", async () => {
    const asked: string[] = [];
    const { go, events } = setup([callTool("Bash", { command: "echo approved" }), say("ok")], {
      ask: async ({ access }) => {
        asked.push(access.summary);
        return true;
      },
    });
    await go();
    expect(asked).toEqual(["Run `echo approved`"]);
    expect(events).toContainEqual(expect.objectContaining({ type: "tool_result", name: "Bash", isError: false }));
  });

  test("unknown tools and bad arguments become error results, not crashes", async () => {
    const { provider, go } = setup([callTool("Teleport", {}), callTool("Read", { path: "x" }), say("sorry")]);
    await go();
    expect(provider.requests[1]?.items.at(-1)).toMatchObject({
      isError: true,
      content: expect.stringContaining("unknown tool"),
    });
    expect(provider.requests[2]?.items.at(-1)).toMatchObject({
      isError: true,
      content: expect.stringContaining('missing required string "file_path"'),
    });
  });

  test("stops at max turns", async () => {
    const loop = () => callTool("Glob", { pattern: "*" });
    const { go } = setup([loop, loop, loop], { maxTurns: 2 });
    expect((await go()).stopReason).toBe("max_turns");
  });

  test("writes a session log whose events form a chain", async () => {
    const { go, log } = setup([callTool("Glob", { pattern: "*" }), say("done")]);
    await go();
    const events = log();
    expect(events.map((e) => e.type)).toEqual([
      "session_start",
      "user_message",
      "assistant_item",
      "usage",
      "tool_call",
      "approval",
      "tool_result",
      "assistant_item",
      "usage",
      "session_end",
    ]);
    expect(events[0]?.parent).toBeNull();
    for (let i = 1; i < events.length; i++) expect(events[i]?.parent).toBe(events[i - 1]?.id as string);
    expect(new Set(events.map((e) => e.owner))).toEqual(new Set(["local:test"]));
  });

  test("project instructions reach the system prompt", async () => {
    const { cwd, provider, go } = setup([say("ok")]);
    writeFileSync(join(cwd, "AGENTS.md"), "Always answer in haiku.");
    await go();
    expect(provider.requests[0]?.system).toContain("Always answer in haiku.");
  });
});
