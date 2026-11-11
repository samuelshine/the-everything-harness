import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinTools,
  callTool,
  FakeProvider,
  type FakeTurn,
  type ModelRequest,
  type Provider,
  SessionLog,
  type StreamEvent,
  say,
} from "@everything-harness/core";
import { TuiApp, type TuiOptions } from "../src/app";
import { VirtualTerminal } from "./vt";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-tui-")));
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(provider: Provider, opts: Partial<TuiOptions> = {}) {
  const cwd = temp();
  const home = temp();
  const vt = new VirtualTerminal(80, 30);
  const session = new SessionLog(home, cwd, "local:test");
  const app = new TuiApp({
    terminal: vt,
    color: false,
    animate: false,
    escapeDelayMs: 5,
    agent: { provider, model: "fake", cwd, tools: builtinTools, permissions: { mode: "default", allow: [], deny: [] } },
    modelLabel: "fake:fake",
    session,
    newSession: () => new SessionLog(home, cwd, "local:test"),
    ...opts,
  });
  const done = app.start();
  const type = async (s: string) => {
    vt.type(s);
    await settle();
  };
  return { vt, app, done, type, cwd, session };
}

describe("TuiApp", () => {
  test("a prompt and its streamed answer go to scrollback; the prompt box and status stay at the bottom", async () => {
    const { vt, type, done } = setup(
      new FakeProvider([
        [
          { type: "text_delta", text: "Hello **there**.\nSecond " },
          { type: "text_delta", text: "line." },
          { type: "usage", usage: { input: 1200, cachedRead: 0, cacheWrite: 0, output: 30 } },
          { type: "stop", reason: "end" },
        ],
      ]),
    );
    await settle();
    expect(vt.text()).toContain("teh · The Everything Harness");
    expect(vt.text()).toContain("Ask teh anything");
    await type("hi there\r");
    const text = vt.text();
    expect(text).toContain("› hi there");
    expect(text).toContain("● Hello there.\n  Second line.");
    expect(text).toContain("fake:fake · 1.2k context");
    // The prompt box is the last thing on screen.
    expect(text.trimEnd().split("\n").slice(-4, -1).join("\n")).toMatch(
      /─+\n› Ask teh anything · \/help for commands\n─+/,
    );
    await type("\x04");
    expect(await done).toBe(0);
    expect(vt.text()).toContain("Continue this conversation with: teh -c");
    expect(vt.raw).toBe(false);
  });

  test("tool calls show a summary and a coloured diff; the conversation carries over to the next prompt", async () => {
    const provider = new FakeProvider([
      callTool("Write", { file_path: "a.txt", content: "one\ntwo\n" }),
      say("created"),
      // user, tool call, tool result, reply, user
      (req: ModelRequest) => say(`I remember ${req.items.length} items`),
    ]);
    const { vt, type, cwd } = setup(provider, {
      agent: {
        provider,
        model: "fake",
        cwd: temp(),
        tools: builtinTools,
        permissions: { mode: "acceptEdits", allow: [], deny: [] },
      },
    });
    void cwd;
    await type("make a file\r");
    // A tool call does not look like chat: its own glyph, Verb(target), and a numbered diff.
    expect(vt.text()).toContain(
      "◆ Create(a.txt)\n  ⎿  Wrote 2 lines to a.txt\n     1 + one\n     2 + two\n\n● created",
    );
    await type("and now?\r");
    expect(vt.text()).toContain("I remember 5 items");
  });

  test("approval: y allows once, a allows for the session, n refuses", async () => {
    const provider = new FakeProvider([
      callTool("Write", { file_path: "a.txt", content: "x" }, "w1"),
      callTool("Write", { file_path: "b.txt", content: "x" }, "w2"),
      callTool("Write", { file_path: "c.txt", content: "x" }, "w3"),
      say("done"),
      callTool("Write", { file_path: "d.txt", content: "x" }, "w4"),
      say("done again"),
    ]);
    const cwd = temp();
    const notes: string[] = [];
    const { vt, type } = setup(provider, {
      agent: {
        provider,
        model: "fake",
        cwd,
        tools: builtinTools,
        permissions: { mode: "default", allow: [], deny: [] },
      },
      onNotify: (m) => notes.push(m),
    });
    await type("write files\r");
    expect(vt.text()).toContain("╭ Allow Create a.txt (1 line)?");
    expect(vt.text()).toContain("a yes, and allow Edit for this session");
    expect(notes).toEqual(["teh needs your permission to use Write"]);
    await type("y");
    expect(vt.text()).toContain("✓ allowed");
    await type("n");
    expect(vt.text()).toContain("✗ not allowed");
    await type("a");
    expect(vt.text()).toContain("✓ allowed for this session");
    expect(existsSync(join(cwd, "a.txt"))).toBe(true);
    expect(existsSync(join(cwd, "b.txt"))).toBe(false);
    expect(existsSync(join(cwd, "c.txt"))).toBe(true);
    // The session rule now allows edits without asking.
    await type("one more\r");
    expect(existsSync(join(cwd, "d.txt"))).toBe(true);
    expect(vt.text()).toContain("done again");
  });

  test("Esc interrupts a run; the next prompt still has the conversation", async () => {
    let second: ModelRequest | undefined;
    const provider: Provider = {
      id: "slow",
      listModels: async () => [],
      probe: async () => ({ supportsTools: true, notes: [] }),
      async *stream(req: ModelRequest, signal?: AbortSignal): AsyncIterable<StreamEvent> {
        if (req.items.length > 1) {
          second = structuredClone(req);
          yield* say("fresh start");
          return;
        }
        yield { type: "text_delta", text: "thinking about it" };
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
      },
    };
    const { vt, type } = setup(provider);
    await type("long task\r");
    expect(vt.text()).toContain("Working… (0s · esc to interrupt)");
    expect(vt.text()).toContain("● thinking about it");
    await type("\x1b");
    await settle();
    expect(vt.text()).toContain("⎿ Interrupted");
    await type("try again\r");
    expect(vt.text()).toContain("fresh start");
    expect(second?.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual(["long task", "try again"]);
  });

  test("messages typed while it works are queued and sent next", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const seen: string[] = [];
    const provider: Provider = {
      id: "gated",
      listModels: async () => [],
      probe: async () => ({ supportsTools: true, notes: [] }),
      async *stream(req: ModelRequest): AsyncIterable<StreamEvent> {
        const last = req.items.at(-1);
        seen.push(last?.kind === "text" ? last.text : "");
        if (seen.length === 1) await gate;
        yield* say(`answer ${seen.length}`);
      },
    };
    const { vt, type } = setup(provider);
    await type("first\r");
    await type("second\r");
    expect(vt.text()).toContain("queued: second");
    release();
    await settle();
    await settle();
    expect(seen).toEqual(["first", "second"]);
    expect(vt.text()).toContain("answer 2");
  });

  test("slash commands: completion, /help, unknown names, /clear starts a new session; Shift+Tab cycles modes", async () => {
    const provider = new FakeProvider([say("one"), say("two")]);
    const { vt, type, app, session } = setup(provider);
    await type("/he");
    expect(vt.text()).toContain("/help            Show keys and commands");
    await type("\t\r");
    expect(vt.text()).toContain("Shift+Tab permission mode");
    await type("\x1b");
    await settle();
    await type("/nope\r");
    expect(vt.text()).toContain("no command named /nope");
    await type("\x1b[Z");
    expect(vt.text()).toContain("⏵⏵ accept edits on");
    await type("\x1b[Z");
    expect(vt.text()).toContain("⏸ plan mode on");
    await type("hello\r");
    expect(provider.requests).toHaveLength(1);
    await type("/clear\r");
    expect(app.currentSession.id).not.toBe(session.id);
    await type("again\r");
    expect(provider.requests[1]?.items).toHaveLength(1);
    expect(readFileSync(session.path, "utf8")).toContain("hello");
  });

  test("the settings panel opens over the prompt box, switches tabs, changes settings, and leaves nothing behind", async () => {
    const saved: [string, string, unknown][] = [];
    const provider = new FakeProvider([
      [
        { type: "text_delta", text: "hi" },
        { type: "usage", usage: { input: 2000, cachedRead: 500, cacheWrite: 0, output: 40 } },
        { type: "stop", reason: "end" },
      ],
    ]);
    const { vt, type } = setup(provider, {
      cacheDays: 3,
      saveSetting: (scope, key, value) => saved.push([scope, key, value]),
      settings: { model: { user: "ollama:big" } },
      models: ["ollama:big", "ollama:small"],
      useModel: async (label) => ({ provider, model: label.slice(7), label, reason: "" }),
      contextWindow: 8000,
      statusInfo: [["Trust", "trusted"]],
    });
    await type("hello\r");
    await type("/usage\r");
    expect(vt.text()).toContain("Settings   Status   Config   Usage   Help");
    expect(vt.text()).toContain("Context   2.5k of 8.0k tokens (32%)");
    expect(vt.text()).toContain("Tokens    2.0k in (500 from cache) · 40 out");
    expect(vt.text()).not.toContain("Ask teh anything");
    // Left to Config: settings for this session, this project and you, each saved where it lives.
    await type("\x1b[D");
    expect(vt.text()).toContain("This session\n❯ Permission mode        default");
    expect(vt.text()).toContain("This project · .teh/settings.local.json");
    expect(vt.text()).toContain("You · ~/.teh/settings.json");
    await type("\r");
    expect(vt.text()).toContain("❯ Permission mode        acceptEdits");
    // Model for this session: switches now, and the next prompt uses it.
    await type("\x1b[B\r");
    expect(vt.text()).toContain("❯ Model                  ollama:big  the next prompt re-reads the conversation");
    await type("\r");
    expect(vt.text()).toContain("❯ Model                  ollama:small");
    // Auto-compact off, project model and start mode, then your own model and retention settings.
    await type("\x1b[B\x1b[B\r");
    expect(vt.text()).toContain("❯ Auto-compact           off  summarises older turns at 75% of 8.0k tokens");
    await type("\x1b[B\r\x1b[B\r\r\x1b[B\r\x1b[B\x1b[B\r\x1b[B\r\x1b[B\r");
    expect(saved).toEqual([
      ["user", "autoCompact", false],
      ["project", "model", "ollama:big"],
      ["project", "permissions.defaultMode", "default"],
      ["project", "permissions.defaultMode", "acceptEdits"],
      ["user", "model", "ollama:small"],
      ["user", "cacheRetentionDays", 7],
      ["user", "cleanupPeriodDays", 60],
      ["user", "checkpointRetentionDays", 7],
    ]);
    expect(vt.text()).toContain("Start in mode          acceptEdits  only while the folder is trusted");
    expect(vt.text()).toContain("❯ Keep undo checkpoints  7 days");
    // Left again to Status; Tab goes forward.
    await type("\x1b[D");
    expect(vt.text()).toContain("Trust            trusted");
    await type("\t\t\t");
    expect(vt.text()).toContain("/btw        Ask a side question");
    // Esc closes it: the prompt box is back and the conversation has no trace of the panel.
    await type("\x1b");
    await settle();
    expect(vt.text()).toContain("⏵⏵ accept edits on");
    expect(vt.text()).not.toContain("Settings");
    expect(vt.text()).toContain("● hi\n─");
  });

  test("the Config tab switches the screen between full screen and inline, keeping the conversation", async () => {
    const saved: unknown[] = [];
    const { vt, type } = setup(new FakeProvider([say("kept on screen")]), {
      fullscreen: true,
      saveSetting: (_scope, key, value) => saved.push([key, value]),
    });
    await type("hello\r");
    expect(vt.alt).toBeDefined();
    await type("/config\r\x1b[B\x1b[B\r");
    expect(vt.alt).toBeUndefined();
    expect(vt.text()).toContain("● kept on screen");
    expect(vt.text()).toContain("❯ Screen                 inline");
    expect(saved).toEqual([["screen", "inline"]]);
    await type("\r");
    expect(vt.alt).toBeDefined();
    expect(vt.text()).toContain("● kept on screen");
    expect(saved).toEqual([
      ["screen", "inline"],
      ["screen", undefined],
    ]);
  });

  test("with no pinned model, the first prompt of each session picks one and it holds until /clear", async () => {
    const provider = new FakeProvider([say("a"), say("b"), say("c")]);
    const asked: string[] = [];
    const { vt, type } = setup(provider, {
      pickModel: async (prompt) => {
        asked.push(prompt);
        const model = prompt.includes("refactor") ? "big" : "small";
        return { provider, model, label: `ollama:${model}`, reason: "S: short question" };
      },
    });
    await type("what is this?\r");
    expect(vt.text()).toContain("model: ollama:small · chosen for this task (S: short question)");
    await type("refactor everything\r");
    // Same session: the model does not change mid-conversation, so the cache survives.
    expect(provider.requests.map((r) => r.model)).toEqual(["small", "small"]);
    await type("/clear\r");
    await type("refactor everything\r");
    expect(provider.requests[2]?.model).toBe("big");
    expect(asked).toEqual(["what is this?", "refactor everything"]);
  });

  test("an explore subagent shows as one tool call with a Done line; its steps stay out of the transcript", async () => {
    const explorer = new FakeProvider([callTool("Glob", { pattern: "*.txt" }), say("Two text files.")]);
    const provider = new FakeProvider([
      callTool("Task", { description: "count text files", prompt: "How many .txt files are there?" }),
      say("There are two."),
    ]);
    const { vt, type } = setup(provider, {
      agent: {
        provider,
        model: "fake",
        cwd: temp(),
        tools: builtinTools,
        permissions: { mode: "default", allow: [], deny: [] },
        explore: { provider: explorer, model: "small", label: "ollama:small" },
      },
    });
    await type("how many?\r");
    expect(vt.text()).toMatch(
      /◆ Explore\(count text files\)\n {2}⎿ {2}Done \(1 tool use · 15 tokens · \d+s · ollama:small\)\n\n● There are two\./,
    );
    expect(vt.text()).not.toContain("Glob");
  });

  test("/btw answers a side question without adding it to the conversation", async () => {
    const provider = new FakeProvider([say("main answer"), say("it is **blue**"), say("second answer")]);
    const { vt, type } = setup(provider);
    await type("first\r");
    await type("/btw what colour is the sky?\r");
    expect(vt.text()).toContain(
      "╭ btw what colour is the sky?\n  │ it is blue\n  ╰ side answer · not added to the conversation",
    );
    // The side request saw the conversation, had no tools, and left the history alone.
    expect(provider.requests[1]?.tools).toEqual([]);
    expect(provider.requests[1]?.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual([
      "first",
      "main answer",
      "what colour is the sky?",
    ]);
    await type("second\r");
    expect(provider.requests[2]?.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual([
      "first",
      "main answer",
      "second",
    ]);
  });

  test("/compact replaces the conversation with a summary; the transcript stays and a resume continues from it", async () => {
    const provider = new FakeProvider([say("main answer"), say("We talked about X."), say("next answer")]);
    const { vt, type, session } = setup(provider, { contextWindow: 100_000 });
    await type("/compact\r");
    expect(vt.text()).toContain("nothing to compact yet");
    await type("first\r");
    await type("/compact focus on X\r");
    expect(vt.text()).toContain("✻ Conversation compacted (you asked): ~");
    expect(vt.text()).toContain("› first");
    // The summariser was asked with the instructions and no tools.
    expect(provider.requests[1]?.tools).toEqual([]);
    expect(JSON.stringify(provider.requests[1]?.items)).toContain("The user asks: focus on X");
    await type("second\r");
    const sent = provider.requests[2]?.items ?? [];
    expect(sent).toHaveLength(2);
    expect(sent[0]?.kind === "text" && sent[0].text).toContain("We talked about X.");
    expect(sent[0]?.kind === "text" && sent[0].text).toContain("- first");
    expect(sent[1]).toEqual({ kind: "text", role: "user", text: "second" });
    const { loadSession } = await import("@everything-harness/core");
    expect(loadSession(session.path).items.length).toBe(3);
  });

  test("an edit shows a diff with line numbers, removed and added lines apart", async () => {
    const provider = new FakeProvider([
      callTool("Read", { file_path: "a.txt" }),
      callTool("Edit", { file_path: "a.txt", old_string: "two", new_string: "2\nII" }),
      say("done"),
    ]);
    const { vt, type, cwd } = setup(provider);
    writeFileSync(join(cwd, "a.txt"), "one\ntwo\nthree\n");
    await type("\x1b[Zedit it\r");
    expect(vt.text()).toContain(
      "◆ Read(a.txt)\n  ⎿  Read 4 lines\n\n◆ Edit(a.txt)\n  ⎿  Updated a.txt with 2 additions and 1 removal\n     1   one\n     2 - two\n     2 + 2\n     3 + II\n     4   three",
    );
  });

  test("Ctrl+C clears the prompt, and twice in a row quits", async () => {
    const { vt, type, done } = setup(new FakeProvider([]));
    await type("draft");
    await type("\x03");
    expect(vt.text()).not.toContain("draft");
    await type("\x03");
    expect(vt.text()).toContain("Press Ctrl+C again to exit");
    await type("\x03");
    expect(await done).toBe(0);
  });

  test("a pasted block is one input, not several prompts", async () => {
    const provider = new FakeProvider([say("ok")]);
    const { type } = setup(provider);
    await type("\x1b[200~line one\r\nline two\x1b[201~\r");
    expect(provider.requests[0]?.items[0]).toEqual({ kind: "text", role: "user", text: "line one\nline two" });
  });
});

// The scripted-turn type is re-exported for other suites.
export type { FakeTurn };
