import { describe, expect, test } from "bun:test";
import { Editor } from "../src/editor";
import { KeyParser } from "../src/keys";
import { InlineRenderer } from "../src/renderer";
import { clip, makeStyle, stripAnsi, width, wrapLine } from "../src/text";
import { VirtualTerminal } from "./vt";

const now = (fn: () => void) => fn();

describe("InlineRenderer", () => {
  test("committed lines go above the live area; the live area is redrawn in place", () => {
    const vt = new VirtualTerminal(40, 10);
    const r = new InlineRenderer(vt, now);
    r.setLive(["> typing", "status"]);
    expect(vt.text()).toBe("> typing\nstatus");
    r.commit(["hello", "world"]);
    expect(vt.text()).toBe("hello\nworld\n> typing\nstatus");
    r.setLive(["> typing more", "status"]);
    expect(vt.text()).toBe("hello\nworld\n> typing more\nstatus");
    // Shrinking clears the lines left behind.
    r.setLive(["> done"]);
    expect(vt.text()).toBe("hello\nworld\n> done");
    r.clear();
    expect(vt.text()).toBe("hello\nworld\n");
  });

  test("only changed lines are rewritten, inside a synchronized update", () => {
    const vt = new VirtualTerminal(40, 10);
    const r = new InlineRenderer(vt, now);
    r.setLive(["a", "b", "c"]);
    vt.written = "";
    r.setLive(["a", "B", "c"]);
    expect(vt.written.startsWith("\x1b[?2026h")).toBe(true);
    expect(vt.written.endsWith("\x1b[?2026l")).toBe(true);
    expect(vt.written).not.toContain("\x1b[2Ka");
    expect(vt.written).toContain("\x1b[2KB");
    vt.written = "";
    r.setLive(["a", "B", "c"]);
    expect(vt.written).toBe("");
  });

  test("lines wider than the terminal are clipped; the live area never exceeds the screen", () => {
    const vt = new VirtualTerminal(12, 4);
    const r = new InlineRenderer(vt, now);
    r.setLive(["0123456789abcdef", "1", "2", "3", "4"]);
    expect(vt.text()).toBe("2\n3\n4");
    r.setLive(["0123456789abcdef"]);
    expect(vt.text()).toBe("0123456789…");
  });

  test("updates in one tick are drawn once", async () => {
    const vt = new VirtualTerminal();
    const r = new InlineRenderer(vt);
    r.setLive(["x"]);
    r.setLive(["y"]);
    r.commit(["done"]);
    expect(vt.written).toBe("");
    await Promise.resolve();
    expect(vt.text()).toBe("done\ny");
    expect(vt.written.split("\x1b[?2026h")).toHaveLength(2);
  });
});

describe("text", () => {
  const s = makeStyle(true);
  test("width ignores escapes and counts wide characters twice", () => {
    expect(width(s.red("abc"))).toBe(3);
    expect(width("日本")).toBe(4);
    expect(width("é")).toBe(1);
  });

  test("wrapping breaks at spaces and carries styles across the break", () => {
    expect(wrapLine("the quick brown fox", 10)).toEqual(["the quick ", "brown fox"]);
    expect(wrapLine("abcdefghij", 4)).toEqual(["abcd", "efgh", "ij"]);
    const styled = wrapLine(s.bold("aaaa bbbb"), 5);
    expect(styled.map(stripAnsi)).toEqual(["aaaa ", "bbbb"]);
    expect(styled[1]?.startsWith("\x1b[1m")).toBe(true);
    expect(stripAnsi(clip("abcdef", 4))).toBe("abc…");
  });

  test("NO_COLOR style adds no colour", () => {
    expect(makeStyle(false).red("x")).toBe("x");
  });
});

describe("KeyParser", () => {
  const p = new KeyParser();
  test("printable runs, control keys and arrows", () => {
    expect(p.feed("hi\r")).toEqual([{ kind: "char", text: "hi" }, { kind: "enter" }]);
    expect(p.feed("\x1b[A\x1b[B\x1b[1;5D\x7f\x03\x04\t\x1b[Z").map((k) => k.kind)).toEqual([
      "up",
      "down",
      "wordLeft",
      "backspace",
      "ctrlC",
      "ctrlD",
      "tab",
      "shiftTab",
    ]);
  });

  test("Shift+Enter in its xterm, kitty and Alt forms is a new line", () => {
    expect(p.feed("\x1b[27;2;13~\x1b[13;2u\x1b\r\n").map((k) => k.kind)).toEqual([
      "newline",
      "newline",
      "newline",
      "newline",
    ]);
  });

  test("bracketed paste arrives whole, even split across reads", () => {
    expect(p.feed("\x1b[200~line one\r\nline")).toEqual([]);
    expect(p.feed(" two\x1b[201~x")).toEqual([
      { kind: "paste", text: "line one\nline two" },
      { kind: "char", text: "x" },
    ]);
  });

  test("a lone ESC waits, then becomes the Escape key", () => {
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.pendingEscape).toBe(true);
    expect(p.flushEscape()).toEqual([{ kind: "escape" }]);
    expect(p.feed("\x1b")).toEqual([]);
    expect(p.feed("[C")).toEqual([{ kind: "right" }]);
  });
});

describe("Editor", () => {
  const plain = makeStyle(false);
  test("edits, multi-line input, and a trailing backslash continuing the line", () => {
    const e = new Editor();
    e.handle({ kind: "char", text: "helo" });
    e.handle({ kind: "left" });
    e.handle({ kind: "char", text: "l" });
    expect(e.text).toBe("hello");
    e.handle({ kind: "end" });
    e.handle({ kind: "char", text: "\\" });
    expect(e.handle({ kind: "enter" })).toBeUndefined();
    e.handle({ kind: "char", text: "world" });
    expect(e.text).toBe("hello\nworld");
    expect(e.render(plain, 40).map(stripAnsi)).toEqual(["› hello", "  world "]);
    e.handle({ kind: "wordBackspace" });
    expect(e.handle({ kind: "enter" })).toEqual({ submit: "hello\n" });
    expect(e.text).toBe("");
  });

  test("up and down walk history and come back to the draft", () => {
    const e = new Editor(["first", "second"]);
    e.handle({ kind: "char", text: "draft" });
    e.handle({ kind: "up" });
    expect(e.text).toBe("second");
    e.handle({ kind: "up" });
    expect(e.text).toBe("first");
    e.handle({ kind: "down" });
    e.handle({ kind: "down" });
    expect(e.text).toBe("draft");
  });
});
