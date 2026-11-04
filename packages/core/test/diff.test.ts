import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { diffSnippet } from "../src/tools/diff";
import { editTool, readTool, writeTool } from "../src/tools/files";
import { tempDir, toolContext } from "./helpers";

describe("diffSnippet", () => {
  test("shows removed and added lines with line numbers and context", () => {
    const d = diffSnippet("a\nb\nc\nd\ne\n", "a\nb\nX\nd\ne\n");
    expect(d).toMatchObject({ removed: 1, added: 1 });
    expect(d.text).toBe(["  1  a", "  2  b", "- 3  c", "+ 3  X", "  4  d", "  5  e"].join("\n"));
  });

  test("a pure insertion removes nothing", () => {
    const d = diffSnippet("one\ntwo\n", "one\nnew\ntwo\n");
    expect(d).toMatchObject({ removed: 0, added: 1 });
    expect(d.text).toContain("+ 2  new");
  });

  test("long diffs are cut in the middle", () => {
    const before = Array.from({ length: 100 }, (_, i) => `l${i}`).join("\n");
    const d = diffSnippet(before, "");
    expect(d.removed).toBe(100);
    expect(d.text).toContain("more diff lines");
    expect(d.text.split("\n").length).toBeLessThan(35);
  });
});

describe("edit results show what changed", () => {
  const setup = async (content: string) => {
    const dir = tempDir();
    const ctx = toolContext(dir);
    writeFileSync(join(dir, "math.js"), content);
    await readTool.run(readTool.parse({ file_path: "math.js" }), ctx);
    return { dir, ctx };
  };

  test("replacing the wrong line is visible to the model", async () => {
    // The failure seen in E7/E8: the model meant to add subtract but replaced add.
    const { ctx } = await setup("export const add = (a, b) => a + b;\n");
    const r = await editTool.run(
      editTool.parse({
        file_path: "math.js",
        old_string: "export const add = (a, b) => a + b;",
        new_string: "export const subtract = (a, b) => a - b;",
      }),
      ctx,
    );
    expect(r.content).toContain("1 line removed, 1 line added");
    expect(r.content).toContain("- 1  export const add = (a, b) => a + b;");
    expect(r.content).toContain("+ 1  export const subtract = (a, b) => a - b;");
  });

  test("overwriting reports the diff; creating reports the size", async () => {
    const { dir, ctx } = await setup("keep\ndrop\n");
    const r = await writeTool.run(writeTool.parse({ file_path: "math.js", content: "keep\n" }), ctx);
    expect(r.content).toContain("1 line removed, 0 lines added");
    expect(r.content).toContain("- 2  drop");
    expect(readFileSync(join(dir, "math.js"), "utf8")).toBe("keep\n");
    const c = await writeTool.run(writeTool.parse({ file_path: "new.js", content: "a\nb" }), ctx);
    expect(c.content).toBe("created new.js (2 lines)");
  });
});
