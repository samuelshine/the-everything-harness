import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandMentions, findMentions, listFiles, rankFiles } from "../src/mentions";
import { parseRules } from "../src/permissions";
import { tempDir } from "./helpers";

const perms = (deny: string[] = []) => ({ mode: "default" as const, allow: [], deny: parseRules(deny) });

test("finds @paths, quoted paths, and drops trailing punctuation", () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "a.ts"), "x");
  expect(findMentions('see @a.ts, then @"my file.md" and email me@example.com', cwd)).toEqual([
    { token: "@a.ts,", path: "a.ts" },
    { token: '@"my file.md"', path: "my file.md" },
  ]);
});

test("attaches files and folders; reports missing, binary and denied ones", () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "const a = 1;\n");
  writeFileSync(join(cwd, "src", "b.ts"), "b");
  writeFileSync(join(cwd, ".env"), "SECRET=1\n");
  writeFileSync(join(cwd, "bin.dat"), Buffer.from([1, 0, 2]));
  writeFileSync(join(cwd, "shot.png"), "png");
  const r = expandMentions("check @src/a.ts @src/ @nope.txt @.env @bin.dat @shot.png", {
    cwd,
    permissions: perms(["Read(./.env)"]),
  });
  expect(r.mentions.map((m) => [m.path, m.kind])).toEqual([
    ["src/a.ts", "file"],
    ["src", "dir"],
    ["nope.txt", "missing"],
    [".env", "denied"],
    ["bin.dat", "binary"],
    ["shot.png", "image"],
  ]);
  expect(r.prompt).toStartWith("check @src/a.ts");
  expect(r.prompt).toContain('<file path="src/a.ts">\nconst a = 1;\n</file>');
  expect(r.prompt).toContain('<directory path="src">\na.ts\nb.ts\n</directory>');
  expect(r.prompt).toContain('<image path="shot.png">');
  expect(r.prompt).not.toContain("SECRET");
  expect(expandMentions("no mentions here", { cwd, permissions: perms() }).prompt).toBe("no mentions here");
});

test("long files are cut with a note", () => {
  const cwd = tempDir();
  writeFileSync(join(cwd, "big.txt"), Array.from({ length: 2500 }, (_, i) => `line ${i}`).join("\n"));
  const r = expandMentions("@big.txt", { cwd, permissions: perms() });
  expect(r.mentions[0]?.note).toContain("first 2000 lines");
  expect(r.prompt).not.toContain("line 2001");
});

test("ranks completions: prefix, then base name, then substring, then fuzzy; offers folders", () => {
  const files = ["src/app.ts", "src/apply.ts", "test/app.test.ts", "docs/api.md", "README.md"];
  expect(rankFiles(files, "src/ap")).toEqual(["src/app.ts", "src/apply.ts"]);
  expect(rankFiles(files, "app")[0]).toBe("src/app.ts");
  expect(rankFiles(files, "")).toContain("src/");
  expect(rankFiles(files, "dcapi")).toEqual(["docs/api.md"]);
});

test("lists files without git, skipping dependency folders", () => {
  const cwd = tempDir();
  mkdirSync(join(cwd, "node_modules", "x"), { recursive: true });
  writeFileSync(join(cwd, "node_modules", "x", "i.js"), "");
  mkdirSync(join(cwd, "src"));
  writeFileSync(join(cwd, "src", "a.ts"), "");
  expect(listFiles(cwd)).toEqual(["src/a.ts"]);
  expect(listFiles(cwd, ["one", "two"], 1)).toEqual(["one"]);
});
