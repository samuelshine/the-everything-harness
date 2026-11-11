import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
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
    expect(vt.text()).toContain("● Create a.txt");
    expect(vt.text()).toContain("⎿ created a.txt (3 lines)");
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
    expect(vt.text()).toContain("Shift+Tab cycle permission mode");
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
