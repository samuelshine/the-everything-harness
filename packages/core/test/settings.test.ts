import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isTrusted, loadSettings, setTrusted } from "../src/settings";
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
});
