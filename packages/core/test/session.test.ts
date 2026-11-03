import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { conversationAt, findSession, listSessions, loadSession, type RewindPoint, SessionLog } from "../src/session";
import { tempDir } from "./helpers";

function session(home = tempDir(), root = tempDir()) {
  const log = new SessionLog(home, root, "local:test");
  log.append("session_start", { provider: "ollama", model: "gemma4:e4b" });
  return { home, root, log };
}

describe("session replay", () => {
  test("rebuilds the conversation and appends to the same file on resume", () => {
    const { home, root, log } = session();
    log.append("user_message", { text: "first" });
    log.append("assistant_item", { kind: "tool_call", id: "c1", name: "Read", args: { file_path: "a" } });
    log.append("approval", { id: "c1", behavior: "allow" });
    log.append("tool_result", { kind: "tool_result", callId: "c1", name: "Read", content: "x", isError: false });
    log.append("assistant_item", { kind: "text", role: "assistant", text: "done" });

    const loaded = loadSession(log.path);
    expect(loaded).toMatchObject({ id: log.id, model: "ollama:gemma4:e4b", firstPrompt: "first", prompts: 1 });
    expect(loaded.items.map((i) => i.kind)).toEqual(["text", "tool_call", "tool_result", "text"]);

    const resumed = new SessionLog(home, root, "local:test", loaded);
    expect(resumed.path).toBe(log.path);
    resumed.append("user_message", { text: "second" });
    const lines = readFileSync(log.path, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines.at(-1).parent).toBe(loaded.lastEventId);
    expect(lines.at(-1).session).toBe(log.id);
    if (process.platform !== "win32") expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  test("ignores a torn final line", () => {
    const { log } = session();
    log.append("user_message", { text: "hi" });
    appendFileSync(log.path, '{"v":1,"id":"torn');
    expect(loadSession(log.path).items).toHaveLength(1);
  });

  test("closes tool calls left without results, keeping results grouped", () => {
    const { log } = session();
    log.append("user_message", { text: "go" });
    log.append("assistant_item", { kind: "tool_call", id: "a", name: "Read", args: {} });
    log.append("assistant_item", { kind: "tool_call", id: "b", name: "Bash", args: {} });
    log.append("tool_result", { kind: "tool_result", callId: "a", name: "Read", content: "ok" });
    const items = loadSession(log.path).items;
    expect(items.map((i) => (i.kind === "tool_result" ? `result:${i.callId}` : i.kind))).toEqual([
      "text",
      "tool_call",
      "tool_call",
      "result:a",
      "result:b",
    ]);
    expect(items.at(-1)).toMatchObject({ isError: true, content: expect.stringContaining("interrupted") });
  });

  test("lists newest first and finds by unique prefix", async () => {
    const home = tempDir();
    const root = tempDir();
    const a = session(home, root).log;
    a.append("user_message", { text: "older" });
    await Bun.sleep(20);
    const b = session(home, root).log;
    b.append("user_message", { text: "newer" });
    expect(listSessions(home, root).map((s) => s.firstPrompt)).toEqual(["newer", "older"]);
    expect(findSession(home, root, a.id.slice(0, 30))?.firstPrompt).toBe("older");
    expect(findSession(home, root, "")).toBeUndefined(); // ambiguous
    expect(listSessions(home, tempDir())).toEqual([]);
  });
});

describe("rewind points", () => {
  test("prompt points take the files from the next change; rewinds keep points and mark the skipped ones", () => {
    const { log } = session();
    log.append("user_message", { text: "one" });
    const afterOne = log.lastEventId;
    log.append("checkpoint", { sha: "s1", kind: "step", title: "Edit a", conversationAt: afterOne });
    log.append("assistant_item", { kind: "text", role: "assistant", text: "did one" });
    log.append("user_message", { text: "two" }); // no changes in prompt two
    log.append("assistant_item", { kind: "text", role: "assistant", text: "did two" });

    let s = loadSession(log.path);
    expect(s.points.map((p) => [p.n, p.kind, p.prompt, p.sha])).toEqual([
      [1, "prompt", 1, "s1"],
      [2, "step", 1, "s1"],
      [3, "prompt", 2, undefined], // teh changed nothing after it
    ]);

    // Conversation-only rewind to point 2: prompt two is set aside but stays listed.
    log.append("checkpoint", { kind: "rewind", title: "Before rewinding to point 2", conversationAt: log.lastEventId });
    log.append("rewind", { to: afterOne, scope: "conversation", point: 2 });
    s = loadSession(log.path);
    expect(s.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual(["one"]);
    expect(s.points.map((p) => [p.n, p.rewound])).toEqual([
      [1, false],
      [2, false],
      [3, true],
      [4, false],
    ]);
    expect(conversationAt(log.path, s.points[3] as RewindPoint).map((i) => (i.kind === "text" ? i.text : ""))).toEqual([
      "one",
      "did one",
      "two",
      "did two",
    ]);

    // A code-only rewind leaves the conversation alone.
    log.append("rewind", { to: null, scope: "code", point: 1 });
    expect(loadSession(log.path).items).toHaveLength(1);
  });
});
