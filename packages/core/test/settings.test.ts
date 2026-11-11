import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrusted, loadSettings, setProjectSetting, setTrusted, setUserSetting } from "../src/settings";
import { tempDir } from "./helpers";

const write = (path: string, data: unknown) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, typeof data === "string" ? data : JSON.stringify(data));
};

describe("settings files", () => {
  test("reads user and project rules from .teh and .claude", () => {
    const teh = tempDir();
    const home = tempDir();
    const root = tempDir();
    write(join(teh, "settings.json"), { permissions: { allow: ["Bash(npm test:*)"] } });
    write(join(home, ".claude", "settings.json"), { permissions: { deny: ["Read(~/.ssh/**)"] } });
    write(join(root, ".claude", "settings.json"), { permissions: { allow: ["Bash"], ask: ["Bash(git push:*)"] } });
    write(join(root, ".teh", "settings.local.json"), { permissions: { deny: ["Edit(*.lock)"] } });
    const s = loadSettings(teh, root, home);
    expect(s.user.allow.map((r) => r.pattern)).toEqual(["npm test:*"]);
    expect(s.user.deny[0]).toMatchObject({ tool: "Read", pattern: "~/.ssh/**" });
    expect(s.project.allow).toEqual([{ tool: "Bash", source: join(root, ".claude", "settings.json") }]);
    expect(s.project.ask[0]?.pattern).toBe("git push:*");
    expect(s.project.deny[0]?.pattern).toBe("*.lock");
    expect(s.problems).toEqual([]);
  });

  test("reports broken files instead of failing", () => {
    const root = tempDir();
    write(join(root, ".teh", "settings.json"), "{ nope");
    write(join(root, ".claude", "settings.json"), { permissions: { allow: "Bash" } });
    const s = loadSettings(tempDir(), root, tempDir());
    expect(s.problems.map((p) => p.message)).toEqual([
      expect.stringContaining("not valid JSON"),
      "permissions.allow must be a list of strings",
    ]);
  });

  test("reads the sandbox section and resolves allowWrite paths", () => {
    const teh = tempDir();
    const home = tempDir();
    const root = tempDir();
    write(join(teh, "settings.json"), { sandbox: { network: false, allowWrite: ["~/scratch"] } });
    write(join(root, ".teh", "settings.json"), { sandbox: { enabled: false, allowWrite: ["out"] } });
    const s = loadSettings(teh, root, home);
    expect(s.sandbox.user).toEqual({ network: false, allowWrite: [join(home, "scratch")] });
    expect(s.sandbox.project).toEqual({ enabled: "off", allowWrite: [join(root, "out")] });
    write(join(root, ".claude", "settings.json"), { sandbox: { enabled: "sometimes" } });
    expect(loadSettings(teh, root, home).problems[0]?.message).toContain("sandbox.enabled");
  });

  test("trust is recorded per project root", () => {
    const teh = tempDir();
    const root = tempDir();
    expect(isTrusted(teh, root)).toBe(false);
    setTrusted(teh, root, true);
    expect(isTrusted(teh, root)).toBe(true);
    expect(isTrusted(teh, tempDir())).toBe(false);
    setTrusted(teh, root, false);
    expect(isTrusted(teh, root)).toBe(false);
  });

  test("model, roles.explore, permissions.defaultMode, screen and retention settings; writers keep other keys", () => {
    const teh = tempDir();
    const root = tempDir();
    const home = tempDir();
    writeFileSync(
      join(teh, "settings.json"),
      JSON.stringify({
        model: "ollama:big",
        screen: "inline",
        cleanupPeriodDays: 7,
        checkpointRetentionDays: 14,
        permissions: { defaultMode: "acceptEdits", allow: ["Read"] },
      }),
    );
    expect(setProjectSetting(root, "model", "ollama:small")).toBe(true);
    expect(setProjectSetting(root, "roles.explore", "ollama:tiny")).toBe(true);
    expect(setProjectSetting(root, "permissions.defaultMode", "plan")).toBe(true);
    const s = loadSettings(teh, root, home);
    expect(s.model).toEqual({ user: "ollama:big", project: "ollama:small" });
    expect(s.exploreModel).toEqual({ project: "ollama:tiny" });
    expect(s.defaultMode).toEqual({ user: "acceptEdits", project: "plan" });
    expect(s.screen).toBe("inline");
    expect(s.cleanupPeriodDays).toBe(7);
    expect(s.checkpointRetentionDays).toBe(14);
    expect(s.user.allow).toHaveLength(1);
    // The personal project file is kept out of git.
    expect(readFileSync(join(root, ".teh", ".gitignore"), "utf8")).toBe("settings.local.json\n");
    // Writers keep what was there; undefined removes a key.
    expect(setUserSetting(teh, "screen", undefined)).toBe(true);
    const back = JSON.parse(readFileSync(join(teh, "settings.json"), "utf8"));
    expect(back.screen).toBeUndefined();
    expect(back.permissions.allow).toEqual(["Read"]);
    writeFileSync(join(teh, "settings.json"), "[1]");
    expect(setUserSetting(teh, "model", "x")).toBe(false);
    // Claude Code's "model" names its own models; teh ignores it there.
    write(join(home, ".claude", "settings.json"), { model: "opus" });
    expect(loadSettings(tempDir(), tempDir(), home).model).toEqual({});
    // Bad values are reported, not used.
    writeFileSync(join(teh, "settings.json"), JSON.stringify({ cleanupPeriodDays: 0, screen: "big" }));
    const bad = loadSettings(teh, tempDir(), home);
    expect(bad.cleanupPeriodDays).toBeUndefined();
    expect(bad.problems.map((p) => p.message)).toEqual([
      "cleanupPeriodDays must be a number of days (1 or more)",
      'screen must be "fullscreen" or "inline"',
    ]);
  });
});
