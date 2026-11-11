import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneCaches, pruneSessions, TranscriptCache } from "../src/cache";
import { SessionLog } from "../src/session";
import { tempDir } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

describe("TranscriptCache", () => {
  test("appends batches of lines and loads them back; a torn last line is skipped", () => {
    const home = tempDir();
    const c = new TranscriptCache(home, "/some/project");
    expect(c.load("s1")).toBeUndefined();
    c.append("s1", ["a", "b"]);
    c.append("s1", ["c"]);
    writeFileSync(c.path("s1"), '["a","b"]\n["c"]\n["tor', { flag: "w" });
    expect(c.load("s1")).toEqual(["a", "b", "c"]);
  });

  test("pruneCaches removes caches idle past the retention and leaves sessions alone", () => {
    const home = tempDir();
    const root = tempDir();
    const session = new SessionLog(home, root, "local:test");
    session.append("user_message", { text: "hi" });
    const c = new TranscriptCache(home, root);
    c.append("old", ["x"]);
    c.append("fresh", ["y"]);
    const fourDaysAgo = new Date(Date.now() - 4 * DAY);
    utimesSync(c.path("old"), fourDaysAgo, fourDaysAgo);
    utimesSync(session.path, fourDaysAgo, fourDaysAgo);
    expect(pruneCaches(home, 3)).toEqual([c.path("old")]);
    expect(existsSync(c.path("fresh"))).toBe(true);
    expect(existsSync(session.path)).toBe(true);
    // A longer retention keeps it.
    c.append("old2", ["z"]);
    utimesSync(c.path("old2"), fourDaysAgo, fourDaysAgo);
    expect(pruneCaches(home, 10)).toEqual([]);
    mkdirSync(join(home, "projects", "empty"), { recursive: true });
    expect(pruneCaches(tempDir(), 3)).toEqual([]);
  });

  test("pruneSessions removes sessions idle past cleanupPeriodDays, with their caches", () => {
    const home = tempDir();
    const root = tempDir();
    const old = new SessionLog(home, root, "local:test");
    old.append("user_message", { text: "old" });
    const fresh = new SessionLog(home, root, "local:test");
    fresh.append("user_message", { text: "fresh" });
    const c = new TranscriptCache(home, root);
    c.append(old.id, ["x"]);
    const long = new Date(Date.now() - 31 * DAY);
    utimesSync(old.path, long, long);
    expect(pruneSessions(home, 30)).toEqual([old.path]);
    expect(existsSync(old.path)).toBe(false);
    expect(existsSync(c.path(old.id))).toBe(false);
    expect(existsSync(fresh.path)).toBe(true);
    expect(pruneSessions(tempDir(), 30)).toEqual([]);
  });
});
