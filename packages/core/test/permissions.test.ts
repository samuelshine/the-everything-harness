import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bashPatternRegex,
  decide,
  type PermissionConfig,
  parseRules,
  pathRuleMatches,
  splitRuleList,
} from "../src/permissions";
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
      { tool: "Bash", pattern: "npm test" },
      { tool: "Bash", pattern: "git status" },
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
    expect(behavior("Bash", cmd("npm install"), config())).toBe("ask");
  });

  test("acceptEdits allows edits in the workspace but not commands or outside writes", () => {
    const c = config({ mode: "acceptEdits" });
    expect(behavior("Edit", inside, c)).toBe("allow");
    expect(behavior("Bash", cmd("npm install"), c)).toBe("ask");
    expect(behavior("Edit", outside, c)).toBe("ask");
  });

  test("plan mode denies every change but runs read-only commands", () => {
    const c = config({ mode: "plan" });
    expect(behavior("Edit", inside, c)).toBe("deny");
    expect(behavior("Bash", cmd("npm install"), c)).toBe("deny");
    expect(behavior("Bash", cmd("ls -la src"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test"), config({ mode: "plan", allow: parseRules(["Bash(npm test)"]) }))).toBe(
      "deny",
    );
    expect(behavior("Read", read, c)).toBe("allow");
  });

  test("exact allow rules match whole commands only", () => {
    const c = config({ allow: parseRules(["Bash(npm test)"]) });
    expect(behavior("Bash", cmd("npm test"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test; rm -rf ~"), c)).toBe("ask");
    expect(behavior("Bash", cmd("npm test --watch"), c)).toBe("ask");
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

describe("read-only commands run without asking (ADR-0003)", () => {
  const allowed = [
    "ls",
    "ls -la src",
    "pwd",
    "cat package.json",
    "head -n 20 src/a.ts",
    "wc -l src/*.ts",
    "grep -rn TODO src",
    "grep -rn '/api/v1' src",
    "rg -n 'foo' --glob '*.ts'",
    "find . -name '*.ts' -type f",
    "git status",
    "git status --short",
    "git log --oneline -10",
    "git diff HEAD~1 -- src",
    "git show HEAD:package.json",
    "git branch",
    "git branch -a --list 'feat/*'",
    "git tag -l",
    "git remote -v",
    "git config --get user.name",
    "git -C sub status",
    "git --no-pager log -1",
    "git stash list",
    "cat a.txt | grep x | sort | uniq -c | head",
    "ls 2>/dev/null || echo none",
    "git diff 2>&1 | head",
    "cd src && ls && cat a.ts",
    "timeout 10 git status",
    "echo hello",
    "jq .name package.json",
    "date +%Y",
    "sort -r a.txt",
    "du -sh .",
    "tree -L 2",
    "sed -n 20,40p src/a.ts",
    "sed -n '1,60p' README.md; sed -n 5p a.txt",
    "sed -n '/^## Start/,/^## End/p' doc.md",
    "sed -n -e 1p -e '$p' a.txt",
  ];
  const asks = [
    "rm a.txt",
    "npm install",
    "npm test",
    "ls; rm -rf ~",
    "git status && rm a",
    "cat a | sh",
    "echo hi > out.txt",
    "ls >> log",
    "cat /etc/passwd",
    "cat ~/.ssh/id_rsa",
    "cat ../other/secret",
    "ls ../",
    "cd .. && ls",
    "cd /etc && cat passwd",
    "find . -exec rm {} ;",
    "find . -delete",
    "find / -name x",
    "sort -o out.txt a.txt",
    "sort -ro out.txt a.txt",
    "rg --pre=evil x",
    "uniq a.txt b.txt",
    "date 010100002030",
    "date -s 2020-01-01",
    "git commit -m x",
    "git push",
    "git branch new-feature",
    "git branch -D old",
    "git tag v1",
    "git config user.name x",
    "git -c core.pager=evil log",
    "git log --output=x",
    "git diff --ext-diff",
    "git stash",
    "git checkout .",
    "git remote add x y",
    "GIT_EXTERNAL_DIFF=evil git diff",
    "PAGER=evil git log",
    "echo $(rm -rf ~)",
    "echo `id`",
    "cat $FILE",
    "ls $HOME",
    "xargs rm < list",
    "env rm x",
    "sh -c 'ls'",
    "sed -i s/a/b/ x",
    "sed -n 1p ../secret",
    "sed s/a/b/ x",
    "sed -n '1p;w out.txt' x",
    "sed -n '1e rm x' x",
    "sed -n '/a/w out' x",
    "sed -f script.sed x",
    "awk '{print}' x",
    "tee out.txt",
    "curl https://example.com",
    "python3 -c 'print(1)'",
    "hostname evil",
    "file -C -m x",
    "cat < /etc/passwd",
    "cat a | tee b",
    "timeout 5 rm x",
  ];
  test.each(allowed)("allows %s", (c) => {
    expect(decide("Bash", cmd(c), config(), ctx)).toMatchObject({ behavior: "allow" });
  });
  test.each(asks)("asks for %s", (c) => {
    expect(behavior("Bash", cmd(c), config())).toBe("ask");
  });
  test("a Read deny rule also stops read-only commands from reading that path", () => {
    const c = config({ deny: parseRules(["Read(.env)"]) });
    expect(behavior("Bash", cmd("cat .env"), c)).toBe("ask");
    expect(behavior("Bash", cmd("cat config/.env"), c)).toBe("ask");
    expect(behavior("Bash", cmd("cat README.md"), c)).toBe("allow");
    // Forward slashes: in bash a backslash is an escape, Windows paths included.
    expect(behavior("Bash", cmd(`cat ${join(ws, ".env").replaceAll("\\", "/")}`), c)).toBe("ask");
    expect(behavior("Read", { kind: "read", paths: [join(ws, ".env")], summary: "Read .env" }, c)).toBe("deny");
  });
});

describe("rules (Claude Code syntax)", () => {
  test("parses lists, prefixes and paths", () => {
    expect(parseRules(["Bash(git add:*), Bash(npm run test *) Edit(src/**)"])).toEqual([
      { tool: "Bash", pattern: "git add:*" },
      { tool: "Bash", pattern: "npm run test *" },
      { tool: "Edit", pattern: "src/**" },
    ]);
    expect(splitRuleList("Read, Bash(git log --format='%h %s':*)")).toEqual([
      "Read",
      "Bash(git log --format='%h %s':*)",
    ]);
  });

  test("bash patterns match words, not raw prefixes", () => {
    const re = bashPatternRegex("npm test:*");
    expect(re.test("npm test")).toBe(true);
    expect(re.test("npm test --watch")).toBe(true);
    expect(re.test("npm testing")).toBe(false);
    expect(bashPatternRegex("git * --stat").test("git diff HEAD --stat")).toBe(true);
    expect(bashPatternRegex("ls *").test("lsof")).toBe(false);
  });

  test("prefix rules apply to each part of a compound command", () => {
    const c = config({ allow: parseRules(["Bash(npm test:*)", "Bash(git add:*)"]) });
    expect(behavior("Bash", cmd("npm test -- --runInBand"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test && git add -A && git status"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test; rm -rf ~"), c)).toBe("ask");
    expect(behavior("Bash", cmd("npm test $(rm -rf ~)"), c)).toBe("ask");
    expect(behavior("Bash", cmd("FOO=1 npm test"), c)).toBe("ask");
    expect(behavior("Bash", cmd("timeout 60 npm test"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test > report.txt"), c)).toBe("allow");
    expect(behavior("Bash", cmd("npm test > /tmp/x"), c)).toBe("ask");
    expect(behavior("Bash", cmd("npm test > .git/hooks/pre-commit"), c)).toBe("ask");
  });

  test("deny rules hit any part, including nested commands", () => {
    const c = config({ mode: "bypassPermissions", deny: parseRules(["Bash(rm:*)", "Bash(git push:*)"]) });
    for (const x of [
      "rm -rf build",
      "ls && rm x",
      "timeout 5 rm x",
      "sh -c 'cd /; rm -rf x'",
      "xargs rm < list",
      "env FOO=1 rm x",
      "sudo rm x",
      "find . -name x -exec rm {} ;",
      "echo $(rm x)",
      "git push --force",
    ]) {
      expect(behavior("Bash", cmd(x), c)).toBe("deny");
    }
    expect(behavior("Bash", cmd("git pushx"), c)).toBe("allow");
    expect(behavior("Bash", cmd("echo firmware"), c)).toBe("allow");
  });

  test("ask rules ask even for read-only commands and allowed edits", () => {
    const c = config({ mode: "acceptEdits", ask: parseRules(["Bash(git log:*)", "Edit(package.json)"]) });
    expect(behavior("Bash", cmd("git log -1"), c)).toBe("ask");
    expect(behavior("Edit", { kind: "write", paths: [join(ws, "package.json")], summary: "x" }, c)).toBe("ask");
    expect(behavior("Edit", inside, c)).toBe("allow");
  });

  test("path rules are relative to the project root and cover every write tool", () => {
    const c = config({ allow: parseRules(["Edit(src/**)"]), deny: parseRules(["Write(*.lock)"]) });
    const w = (p: string): Access => ({ kind: "write", paths: [join(ws, p)], summary: p });
    expect(behavior("Edit", w("src/a.ts"), c)).toBe("allow");
    expect(behavior("Write", w("src/deep/b.ts"), c)).toBe("allow");
    expect(behavior("Edit", w("README.md"), c)).toBe("ask");
    expect(behavior("Edit", w("sub/bun.lock"), c)).toBe("deny");
    expect(pathRuleMatches("~/.ssh/**", "/home/u/.ssh/id", ws, "/home/u")).toBe(true);
    expect(pathRuleMatches("//etc/hosts", "/etc/hosts", ws, "/home/u")).toBe(true);
    expect(pathRuleMatches("src/", join(ws, "src/x/y.ts"), ws, "/home/u")).toBe(true);
  });

  test("protected folders always ask, even with acceptEdits or an Edit rule", () => {
    const c = config({ mode: "acceptEdits", allow: parseRules(["Edit"]) });
    for (const p of [
      ".git/hooks/pre-commit",
      ".teh/settings.json",
      ".claude/settings.local.json",
      ".agents/skills/x/SKILL.md",
    ]) {
      expect(decide("Edit", { kind: "write", paths: [join(ws, p)], summary: p }, c, ctx)).toMatchObject({
        behavior: "ask",
        reason: expect.stringContaining("protected"),
      });
    }
    expect(
      behavior(
        "Edit",
        { kind: "write", paths: [join(ws, ".git/x")], summary: "x" },
        config({ mode: "bypassPermissions" }),
      ),
    ).toBe("allow");
  });

  test("suggests a rule that would allow the action", () => {
    expect(decide("Bash", cmd("npm run build --prod"), config(), ctx).suggestion).toBe("Bash(npm run:*)");
    expect(decide("Bash", cmd("make"), config(), ctx).suggestion).toBe("Bash(make:*)");
    expect(decide("Edit", inside, config(), ctx).suggestion).toBe("Edit");
    expect(decide("Read", readOutside, config(), ctx).suggestion).toBeUndefined();
  });
});

describe("shells teh cannot parse", () => {
  test("with cmd.exe nothing is read-only, but exact rules still work", () => {
    expect(behavior("Bash", cmd("type secrets.txt"), config({ posixShell: false }))).toBe("ask");
    expect(behavior("Bash", cmd("dir"), config({ posixShell: false, allow: parseRules(["Bash(dir)"]) }))).toBe("allow");
  });
});

describe("paths are judged after resolving symlinks", () => {
  test.skipIf(process.platform === "win32")("a link inside the workspace to a file outside asks", () => {
    const { symlinkSync } = require("node:fs") as typeof import("node:fs");
    symlinkSync("/etc/hosts", join(ws, "hosts-link"));
    expect(behavior("Bash", cmd("cat hosts-link"), config())).toBe("ask");
  });
});
