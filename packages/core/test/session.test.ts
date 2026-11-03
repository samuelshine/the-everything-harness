import { describe, expect, test } from "bun:test";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { findSession, listSessions, loadSession, SessionLog } from "../src/session";
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
