import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { decide, type PermissionConfig, parseRules } from "../src/permissions";
import type { Access } from "../src/tools/tool";
import { tempDir, toolContext } from "./helpers";

const ws = tempDir();
const ctx = toolContext(ws);
const inside: Access = { kind: "write", paths: [join(ws, "a.ts")], summary: "Edit a.ts" };
const outside: Access = { kind: "write", paths: ["/etc/hosts"], summary: "Edit /etc/hosts" };
const read: Access = { kind: "read", paths: [join(ws, "a.ts")], summary: "Read a.ts" };
const readOutside: Access = { kind: "read", paths: ["/etc/hosts"], summary: "Read /etc/hosts" };
const cmd = (command: string): Access => ({ kind: "execute", command, summary: command });
const config = (c: Partial<PermissionConfig> = {}): PermissionConfig => ({
  mode: "default",
  allow: [],
  deny: [],
  ...c,
});
const behavior = (tool: string, a: Access, c: PermissionConfig) => decide(tool, a, c, ctx).behavior;

describe("parseRules", () => {
  test("parses tool names and exact commands", () => {
    expect(parseRules(["Edit,Write", "Bash(npm test)", "Bash(git status)"])).toEqual([
      { tool: "Edit" },
      { tool: "Write" },
      { tool: "Bash", command: "npm test" },
      { tool: "Bash", command: "git status" },
    ]);
  });
});

describe("decide (default mode asks before every change)", () => {
  test("reads inside the workspace are allowed; outside they ask", () => {
    expect(behavior("Read", read, config())).toBe("allow");
    expect(behavior("Read", readOutside, config())).toBe("ask");
  });

  test("edits and commands ask", () => {
    expect(behavior("Edit", inside, config())).toBe("ask");
    expect(behavior("Bash", cmd("ls"), config())).toBe("ask");
  });

  test("acceptEdits allows edits in the workspace but not commands or outside writes", () => {
    const c = config({ mode: "acceptEdits" });
    expect(behavior("Edit", inside, c)).toBe("allow");
    expect(behavior("Bash", cmd("ls"), c)).toBe("ask");
    expect(behavior("Edit", outside, c)).toBe("ask");
  });

  test("plan mode denies every change", () => {
    const c = config({ mode: "plan" });
    expect(behavior("Edit", inside, c)).toBe("deny");
    expect(behavior("Bash", cmd("ls"), c)).toBe("deny");
    expect(behavior("Read", read, c)).toBe("allow");
  });

  test("allow rules match whole commands only", () => {
    const c = config({ allow: parseRules(["Bash(git status)"]) });
    expect(behavior("Bash", cmd("git status"), c)).toBe("allow");
    expect(behavior("Bash", cmd("git status; rm -rf ~"), c)).toBe("ask");
    expect(behavior("Bash", cmd("git status --short"), c)).toBe("ask");
  });

  test("deny rules beat everything, including bypassPermissions", () => {
    const c = config({ mode: "bypassPermissions", deny: parseRules(["Bash"]) });
    expect(behavior("Bash", cmd("ls"), c)).toBe("deny");
    expect(behavior("Edit", outside, c)).toBe("allow");
  });

  test("allow rules never cover writes outside the workspace", () => {
    expect(behavior("Edit", outside, config({ allow: parseRules(["Edit"]) }))).toBe("ask");
  });
});
