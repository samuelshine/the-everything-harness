import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bashTool } from "../src/tools/bash";
import { editTool, readTool, writeTool } from "../src/tools/files";
import { globTool, grepTool, scan } from "../src/tools/search";
import { type Tool, type ToolContext, ToolInputError } from "../src/tools/tool";
import { tempDir, toolContext } from "./helpers";

// biome-ignore lint/suspicious/noExplicitAny: tests call tools with raw model-style arguments
const call = (tool: Tool<any>, raw: unknown, ctx: ToolContext) => tool.run(tool.parse(raw), ctx);

describe("Read", () => {
  test("numbers lines and honours offset and limit", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.txt"), "one\ntwo\nthree\nfour");
    const ctx = toolContext(dir);
    expect((await call(readTool, { file_path: "a.txt" }, ctx)).content).toBe(
      "     1\tone\n     2\ttwo\n     3\tthree\n     4\tfour",
    );
    const part = await call(readTool, { file_path: "a.txt", offset: 2, limit: 2 }, ctx);
    expect(part.content).toStartWith("     2\ttwo\n     3\tthree");
    expect(part.content).toContain("4 lines total");
  });

  test("reports missing and binary files as errors", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "bin"), Buffer.from([0, 1, 2]));
    const ctx = toolContext(dir);
    expect((await call(readTool, { file_path: "nope.txt" }, ctx)).isError).toBe(true);
    expect((await call(readTool, { file_path: "bin" }, ctx)).content).toContain("binary");
  });
});

describe("Edit and Write", () => {
  test("Edit requires a fresh read", async () => {
    const dir = tempDir();
    const file = join(dir, "x.ts");
    writeFileSync(file, "const a = 1;\n");
    const ctx = toolContext(dir);
    const before = await call(editTool, { file_path: "x.ts", old_string: "1", new_string: "2" }, ctx);
    expect(before).toEqual({ content: "read x.ts with the Read tool before changing it", isError: true });

    await call(readTool, { file_path: "x.ts" }, ctx);
    utimesSync(file, new Date(), new Date(Date.now() + 5000)); // changed underneath us
    expect((await call(editTool, { file_path: "x.ts", old_string: "1", new_string: "2" }, ctx)).content).toContain(
      "changed since you read it",
    );
  });

  test("Edit replaces a unique match and refuses ambiguous ones", async () => {
    const dir = tempDir();
    const file = join(dir, "x.ts");
    writeFileSync(file, "a\nb\na\n");
    const ctx = toolContext(dir);
    await call(readTool, { file_path: "x.ts" }, ctx);
    const ambiguous = await call(editTool, { file_path: "x.ts", old_string: "a", new_string: "z" }, ctx);
    expect(ambiguous.content).toContain("occurs 2 times");
    await call(editTool, { file_path: "x.ts", old_string: "b", new_string: "$&-$1" }, ctx);
    expect(readFileSync(file, "utf8")).toBe("a\n$&-$1\na\n"); // replacement is literal, not a regex template
    await call(editTool, { file_path: "x.ts", old_string: "a", new_string: "z", replace_all: true }, ctx);
    expect(readFileSync(file, "utf8")).toBe("z\n$&-$1\nz\n");
  });

  test("Edit rejects empty or no-op edits at parse time", () => {
    expect(() => editTool.parse({ file_path: "x", old_string: "", new_string: "y" })).toThrow(ToolInputError);
    expect(() => editTool.parse({ file_path: "x", old_string: "y", new_string: "y" })).toThrow(ToolInputError);
  });

  test("Write creates new files freely but overwrites only after a read", async () => {
    const dir = tempDir();
    const ctx = toolContext(dir);
    await call(writeTool, { file_path: "new/dir/f.txt", content: "hi" }, ctx);
    expect(readFileSync(join(dir, "new/dir/f.txt"), "utf8")).toBe("hi");
    const fresh = toolContext(dir);
    expect((await call(writeTool, { file_path: "new/dir/f.txt", content: "x" }, fresh)).isError).toBe(true);
  });
});

describe("Glob and Grep", () => {
  function project() {
    const dir = tempDir();
    mkdirSync(join(dir, "src"));
    mkdirSync(join(dir, "node_modules/pkg"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "export const answer = 42;\n");
    writeFileSync(join(dir, "src/b.md"), "The Answer is here\n");
    writeFileSync(join(dir, "node_modules/pkg/index.ts"), "answer\n");
    return dir;
  }

  test("Glob finds files and skips node_modules", async () => {
    const dir = project();
    const res = await call(globTool, { pattern: "**/*.ts" }, toolContext(dir));
    expect(res.content).toBe(join("src", "a.ts"));
  });

  test("Grep (built-in scan) supports modes, globs and case folding", async () => {
    const dir = project();
    const ctx = toolContext(dir);
    const base = { mode: "files_with_matches" as const, ignoreCase: false };
    expect(await scan({ ...base, pattern: "answer" }, ctx)).toBe(join("src", "a.ts"));
    expect(await scan({ ...base, pattern: "answer", ignoreCase: true }, ctx)).toBe(
      [join("src", "a.ts"), join("src", "b.md")].join("\n"),
    );
    expect(await scan({ ...base, pattern: "answer", ignoreCase: true, glob: "*.md" }, ctx)).toBe(join("src", "b.md"));
    expect(await scan({ ...base, pattern: "answer", mode: "content" }, ctx)).toBe(
      `${join("src", "a.ts")}:1:export const answer = 42;`,
    );
  });

  test("Grep rejects invalid regular expressions", () => {
    expect(() => grepTool.parse({ pattern: "(" })).toThrow(ToolInputError);
  });
});

describe("Bash", () => {
  test("returns output and exit code", async () => {
    const dir = tempDir();
    const ok = await call(bashTool, { command: "echo hello" }, toolContext(dir));
    expect(ok.content).toContain("hello");
    expect(ok.content).toContain("[exit code 0]");
    expect(ok.isError).toBe(false);
    const bad = await call(bashTool, { command: "exit 3" }, toolContext(dir));
    expect(bad).toMatchObject({ isError: true });
    expect(bad.content).toContain("[exit code 3]");
  });

  test("times out", async () => {
    const res = await call(bashTool, { command: "sleep 5", timeout: 200 }, toolContext(tempDir()));
    expect(res.content).toContain("timed out after 200 ms");
  }, 10_000);
});
