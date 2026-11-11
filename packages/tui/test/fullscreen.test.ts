import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinTools, callTool, FakeProvider, SessionLog, say, TranscriptCache } from "@everything-harness/core";
import { TuiApp } from "../src/app";
import { FullscreenRenderer } from "../src/fullscreen";
import { KeyParser } from "../src/keys";
import { VirtualTerminal } from "./vt";

const now = (fn: () => void) => fn();
const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-fs-")));
const settle = () => new Promise((r) => setTimeout(r, 30));
const rows = (vt: VirtualTerminal) => vt.text().split("\n");

describe("FullscreenRenderer", () => {
  test("header on top, transcript in the middle, live area at the bottom; leaving restores the screen", () => {
    const vt = new VirtualTerminal(30, 8);
    vt.write("shell prompt$ ");
    const r = new FullscreenRenderer(vt, { header: () => "HEADER", schedule: now, mouse: false });
    r.enter();
    r.commit(["one", "two"]);
    r.setLive(["> input", "status"]);
    expect(rows(vt)).toEqual(["HEADER", "one", "two", "", "", "", "> input", "status"]);
    r.leave();
    expect(vt.text()).toBe("shell prompt$");
  });

  test("follows new output; scrolling up holds the view and says how much is below", () => {
    const vt = new VirtualTerminal(40, 7);
    const r = new FullscreenRenderer(vt, { schedule: now, mouse: false });
    r.enter();
    r.setLive(["> "]);
    r.commit(Array.from({ length: 20 }, (_, i) => `line ${i + 1}`));
    // 7 rows: header, 5 transcript rows, 1 live row.
    expect(rows(vt).slice(1, 6)).toEqual(["line 16", "line 17", "line 18", "line 19", "line 20"]);
    r.scroll("page", 1);
    expect(rows(vt).slice(1, 6)).toEqual([
      "line 13",
      "line 14",
      "line 15",
      "line 16",
      "  ↓ 3 more lines below · PgDn or End t…",
    ]);
    r.commit(["line 21"]);
    expect(rows(vt)[1]).toBe("line 13");
    r.scroll("end", -1);
    expect(rows(vt)[5]).toBe("line 21");
    r.scroll("end", 1);
    expect(rows(vt)[1]).toBe("line 1");
  });

  test("long lines wrap to the width and re-wrap after a resize", () => {
    const vt = new VirtualTerminal(12, 6);
    const r = new FullscreenRenderer(vt, { schedule: now, mouse: false });
    r.enter();
    r.commit(["alpha beta gamma delta"]);
    expect(rows(vt).slice(1, 4)).toEqual(["alpha beta", "gamma delta", ""]);
    vt.resize(30);
    r.redraw();
    expect(rows(vt)[1]).toBe("alpha beta gamma delta");
  });

  test("only changed rows are rewritten", () => {
    const vt = new VirtualTerminal(20, 5);
    const r = new FullscreenRenderer(vt, { schedule: now, mouse: false });
    r.enter();
    r.setLive(["a"]);
    vt.written = "";
    r.setLive(["b"]);
    expect(vt.written).toBe("\x1b[?2026h\x1b[5;1H\x1b[2Kb\x1b[?2026l");
  });

  test("wheel, PgUp/PgDn, Shift+arrows and Ctrl+Home/End parse as scroll keys", () => {
    const p = new KeyParser();
    expect(
      p.feed("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;3;3M\x1b[5~\x1b[6~\x1b[1;2A\x1b[1;5H\x1b[1;5F").map((k) => k.kind),
    ).toEqual(["scrollUp", "scrollDown", "pageUp", "pageDown", "scrollUp", "top", "bottom"]);
  });
});

describe("TuiApp full screen, with the session cache", () => {
  test("runs full screen, scrolls with the keyboard, caches the transcript, and redraws it on resume", async () => {
    const cwd = temp();
    const home = temp();
    const cache = new TranscriptCache(home, cwd);
    const session = new SessionLog(home, cwd, "local:test");
    const provider = new FakeProvider([
      callTool("Write", { file_path: "a.txt", content: "one\ntwo" }),
      say(Array.from({ length: 40 }, (_, i) => `reply line ${i + 1}`).join("\n")),
    ]);
    const vt = new VirtualTerminal(80, 20);
    const make = (p: FakeProvider, s: SessionLog, history = [] as import("@everything-harness/core").Item[]) =>
      new TuiApp({
        terminal: vt,
        color: false,
        animate: false,
        fullscreen: true,
        transcript: cache,
        cacheDays: 3,
        agent: {
          provider: p,
          model: "fake",
          cwd,
          tools: builtinTools,
          permissions: { mode: "acceptEdits", allow: [], deny: [] },
        },
        modelLabel: "fake:fake",
        session: s,
        resumed: history.length > 0,
        history,
        newSession: () => new SessionLog(home, cwd, "local:test"),
      });
    const first = make(provider, session);
    const done = first.start();
    await settle();
    expect(vt.alt).toBeDefined();
    expect(rows(vt)[0]).toStartWith("teh · fake:fake");
    vt.type("make a file\r");
    await settle();
    expect(vt.text()).toContain("reply line 40");
    expect(vt.text()).not.toContain("reply line 1\n");
    vt.type("\x1b[5~\x1b[5~\x1b[5~");
    await settle();
    expect(vt.text()).toContain("◆ Create(a.txt)");
    expect(vt.text()).toContain("more lines below");
    vt.type("\x1b[1;5F");
    await settle();
    expect(vt.text()).toContain("reply line 40");
    vt.type("\x04");
    expect(await done).toBe(0);
    expect(vt.alt).toBeUndefined();
    expect(vt.text()).toContain("Continue this conversation with: teh -c");

    // Resume: the cached transcript comes back as it was shown, diff and all.
    const cached = cache.load(session.id) ?? [];
    expect(cached.join("\n")).toContain("⎿  Wrote 2 lines to a.txt\n     1 + one\n     2 + two");
    const resumedSession = new SessionLog(
      home,
      cwd,
      "local:test",
      (await import("@everything-harness/core")).loadSession(session.path),
    );
    const history = (await import("@everything-harness/core")).loadSession(session.path).items;
    const again = make(new FakeProvider([say("still here")]), resumedSession, history);
    const done2 = again.start();
    await settle();
    vt.type("\x1b[1;5H");
    await settle();
    expect(vt.text()).toContain("── earlier in this session ──");
    vt.type("\x04");
    await done2;

    // Once the cache has gone, the transcript is rebuilt from the conversation.
    rmSync(cache.path(session.id));
    const third = make(new FakeProvider([say("ok")]), resumedSession, history);
    const done3 = third.start();
    await settle();
    vt.type("\x1b[1;5H");
    await settle();
    expect(vt.text()).toContain("(rebuilt from the conversation; the detailed view");
    expect(vt.text()).toContain("◆ Write(a.txt)");
    expect(vt.text()).toContain("› make a file");
    vt.type("\x04");
    await done3;
  });
});
