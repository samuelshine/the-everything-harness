// M3 interactive features (ADR-0024): @-mentions, ! shell mode, Ctrl+R, Ctrl+G, Ctrl+V,
// the /resume and /rewind pickers, /copy (OSC 52), links (OSC 8) and the skill router.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  builtinTools,
  FakeProvider,
  type Item,
  type ModelRequest,
  type RewindPoint,
  SessionLog,
  say,
} from "@everything-harness/core";
import { TuiApp, type TuiOptions } from "../src/app";
import { makeStyle, wrapLine } from "../src/text";
import { VirtualTerminal } from "./vt";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-tui-")));
const settle = () => new Promise((r) => setTimeout(r, 30));

function setup(provider: FakeProvider, opts: Partial<TuiOptions> = {}) {
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
  return { vt, app, done, type, cwd, home, session };
}

const lastUserText = (req: ModelRequest | undefined) => {
  const items = req?.items ?? [];
  const u = [...items].reverse().find((i) => i.kind === "text" && i.role === "user");
  return u && u.kind === "text" ? u.text : "";
};

describe("interactive features", () => {
  test("@ completes paths with Tab and attaches the file to the prompt", async () => {
    const provider = new FakeProvider([say("seen it")]);
    const { vt, type, cwd, done } = setup(provider, { listFiles: () => ["src/app.ts", "src/util.ts", "README.md"] });
    writeFileSync(join(cwd, "README.md"), "# hello readme\n");
    await type("look at @REA");
    expect(vt.text()).toContain("@README.md");
    await type("\t");
    await type("please\r");
    expect(vt.text()).toContain("› look at @README.md please");
    expect(vt.text()).toContain("attached README.md");
    const sent = lastUserText(provider.requests[0]);
    expect(sent).toContain('<file path="README.md">\n# hello readme\n</file>');
    await type("@missing.txt hi\r");
    expect(vt.text()).toContain("@missing.txt: no such file; not attached");
    await type("\x04");
    await done;
  });

  test("! runs a shell command, shows its output, and sends it with the next prompt", async () => {
    const provider = new FakeProvider([say("ok")]);
    const ran: string[] = [];
    const { vt, type, done } = setup(provider, {
      runShell: async (cmd) => {
        ran.push(cmd);
        return { output: "line one\nline two\n", code: 0 };
      },
    });
    await type("!");
    expect(vt.text()).toContain("shell mode");
    await type("ls -la\r");
    expect(ran).toEqual(["ls -la"]);
    expect(vt.text()).toContain("! ls -la");
    expect(vt.text()).toContain("line two");
    expect(provider.requests).toHaveLength(0);
    await type("what did that show?\r");
    const sent = lastUserText(provider.requests[0]);
    expect(sent).toContain("<bash-input>ls -la</bash-input>");
    expect(sent).toContain("line one\nline two");
    expect(sent.endsWith("what did that show?")).toBe(true);
    await type("\x04");
    await done;
  });

  test("Ctrl+R searches earlier prompts, including saved ones; Esc restores the draft", async () => {
    const added: string[] = [];
    const { vt, type, app, done } = setup(new FakeProvider([say("a")]), {
      promptHistory: { entries: ["fix the login bug", "write tests for parser", "deploy"], add: (t) => added.push(t) },
    });
    await type("draft");
    await type("\x12");
    expect(vt.text()).toContain("search history:");
    await type("test");
    expect(vt.text()).toContain("write tests for parser");
    await type("\x1b");
    await settle();
    expect(vt.text()).toContain("› draft");
    await type("\x15"); // Ctrl+U clears the line
    await type("\x12bug");
    await type("\r");
    expect(vt.text()).toContain("› fix the login bug");
    await type("\r");
    expect(added).toEqual(["fix the login bug"]);
    void app;
    await type("\x04");
    await done;
  });

  test("Ctrl+G edits the prompt in an external editor and hands the terminal back", async () => {
    const seen: string[] = [];
    const { vt, type, done } = setup(new FakeProvider([]), {
      editExternal: (t) => {
        seen.push(t);
        expect(vt.raw).toBe(false);
        return `${t} and more\n`;
      },
    });
    await type("start");
    await type("\x07");
    expect(seen).toEqual(["start"]);
    expect(vt.raw).toBe(true);
    expect(vt.text()).toContain("› start and more");
    await type("\x04\x15\x04");
    await done;
  });

  test("Ctrl+V puts a pasted image in as an @-mention", async () => {
    const { vt, type, done } = setup(new FakeProvider([]), { pasteImage: async () => "/tmp/shot.png" });
    await type("see");
    await type("\x16");
    expect(vt.text()).toContain("› see @/tmp/shot.png");
    await type("\x15\x04");
    await done;
  });

  test("/resume picks another session and loads its conversation", async () => {
    const provider = new FakeProvider([say("continuing")]);
    const home = temp();
    const cwd = temp();
    const other = new SessionLog(home, cwd, "local:test");
    const items: Item[] = [
      { kind: "text", role: "user", text: "earlier question" },
      { kind: "text", role: "assistant", text: "earlier answer" },
    ];
    const { vt, type, app, done } = setup(provider, {
      sessions: {
        list: () => [
          { id: other.id, path: other.path, updated: new Date(), firstPrompt: "earlier question", prompts: 1 },
        ],
        open: (id) => (id === other.id ? { session: other, items } : undefined),
      },
    });
    await type("/resume\r");
    expect(vt.text()).toContain("Resume a conversation");
    expect(vt.text()).toContain("earlier question");
    await type("\r");
    expect(app.currentSession.id).toBe(other.id);
    expect(vt.text()).toContain("earlier answer");
    await type("go on\r");
    expect(provider.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : ""))).toContain("earlier answer");
    await type("\x04");
    await done;
  });

  test("/rewind lists points newest first, asks what goes back, and puts the prompt back", async () => {
    const point = (n: number, prompt: number, text: string): RewindPoint => ({
      n,
      kind: "prompt",
      title: text,
      time: new Date(),
      prompt,
      promptText: text,
      conversationAt: null,
      rewound: false,
    });
    const calls: [number, string][] = [];
    const { vt, type, done } = setup(new FakeProvider([]), {
      rewind: {
        points: () => [point(1, 1, "first prompt"), point(2, 2, "second prompt")],
        apply: async (_s, p, scope) => {
          calls.push([p.n, scope]);
          return { items: [], lines: ["Files:", "  restore  a.txt"] };
        },
      },
    });
    await type("/rewind\r");
    const text = vt.text();
    expect(text.indexOf("Prompt 2: second prompt")).toBeLessThan(text.indexOf("Prompt 1: first prompt"));
    await type("\x1b[B\r"); // down to prompt 1
    expect(vt.text()).toContain("what goes back?");
    await type("2"); // conversation only
    await settle();
    expect(calls).toEqual([[1, "conversation"]]);
    expect(vt.text()).toContain("restore  a.txt");
    expect(vt.text()).toContain("› first prompt");
    await type("\x15\x04");
    await done;
  });

  test("/copy sends the last reply to the clipboard with OSC 52", async () => {
    const { vt, type, done } = setup(new FakeProvider([say("copy me")]));
    await type("hi\r");
    await type("/copy\r");
    expect(vt.written).toContain(`\x1b]52;c;${Buffer.from("copy me").toString("base64")}\x07`);
    await type("\x04");
    await done;
  });

  test("the skill router's choice is shown and passed to the run", async () => {
    let passed: unknown;
    const { vt, type, done } = setup(new FakeProvider([]), {
      routeSkills: async () => ({ chosen: ["pdf"], candidates: [], mode: "auto" }) as never,
      run: async (o) => {
        passed = o.skillRoute;
        return {
          result: "",
          stopReason: "end",
          turns: 1,
          usage: { input: 0, cachedRead: 0, cacheWrite: 0, output: 0 },
          items: [],
          tokenScale: 1,
        };
      },
    });
    await type("summarise report.pdf\r");
    expect(vt.text()).toContain("skill: pdf");
    expect((passed as { chosen: string[] }).chosen).toEqual(["pdf"]);
    await type("\x04");
    await done;
  });
});

describe("links", () => {
  test("OSC 8 links when supported, the address in brackets when not", () => {
    const on = makeStyle(false, true);
    const off = makeStyle(false, false);
    expect(on.link("docs", "https://example.com")).toBe("\x1b]8;;https://example.com\x1b\\docs\x1b]8;;\x1b\\");
    expect(off.link("docs", "https://example.com")).toBe("docs (https://example.com)");
    expect(off.link("https://example.com", "https://example.com")).toBe("https://example.com");
    // Never an unsafe address in an escape sequence.
    expect(on.link("x", "javascript:alert(1)")).toBe("x");
    expect(on.link("x", "https://a.example/\x07b")).toBe("x");
  });

  test("a wrapped link is closed at the break and reopened on the next line", () => {
    const s = makeStyle(false, true);
    const lines = wrapLine(`see ${s.link("a long link text here", "https://example.com")} end`, 12);
    expect(lines.length).toBeGreaterThan(1);
    for (const l of lines.slice(0, -1)) expect(l.endsWith("\x1b]8;;\x1b\\") || !l.includes("\x1b]8;;https")).toBe(true);
    expect(lines[1]?.startsWith("\x1b]8;;https://example.com")).toBe(true);
  });
});
