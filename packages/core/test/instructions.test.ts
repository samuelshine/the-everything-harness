import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findImports, loadInstructions, renderInstructions } from "../src/instructions";
import { tempDir } from "./helpers";

function repo() {
  const root = tempDir();
  mkdirSync(join(root, ".git"));
  mkdirSync(join(root, "pkg/app"), { recursive: true });
  return root;
}

describe("loadInstructions", () => {
  test("loads root to cwd, AGENTS.md before CLAUDE.md", () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "root agents");
    writeFileSync(join(root, "CLAUDE.md"), "root claude");
    writeFileSync(join(root, "pkg/app/AGENTS.md"), "app agents");
    const files = loadInstructions(join(root, "pkg/app"));
    expect(files.map((f) => f.content)).toEqual(["root agents", "root claude", "app agents"]);
  });

  test("a CLAUDE.md that imports AGENTS.md does not load it twice", () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "shared rules");
    writeFileSync(join(root, "CLAUDE.md"), "@AGENTS.md\n\nClaude-only note");
    const files = loadInstructions(root);
    expect(files.map((f) => f.content)).toEqual(["shared rules", "@AGENTS.md\n\nClaude-only note"]);
  });

  test("follows imports up to four hops", () => {
    const root = repo();
    writeFileSync(join(root, "CLAUDE.md"), "@docs/1.md");
    mkdirSync(join(root, "docs"));
    for (let i = 1; i <= 5; i++)
      writeFileSync(join(root, `docs/${i}.md`), i < 5 ? `level ${i} @${i + 1}.md` : "level 5");
    const files = loadInstructions(root);
    expect(files.map((f) => f.content.split(" @")[0])).toEqual([
      "@docs/1.md",
      "level 1",
      "level 2",
      "level 3",
      "level 4",
    ]);
    expect(files[1]?.importedBy).toBe(join(root, "CLAUDE.md"));
  });

  test("truncates past the budget and says so", () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "x".repeat(100));
    const [f] = loadInstructions(root, { maxChars: 10 });
    expect(f?.content).toStartWith("xxxxxxxxxx\n\n[truncated");
  });
});

describe("findImports", () => {
  test("ignores code fences, inline code and emails", () => {
    const text = "See @docs/a.md and `@not/this.md`\nmail me@example.com\n```\n@also/not.md\n```\n@b.md";
    expect(findImports(text)).toEqual(["docs/a.md", "b.md"]);
  });
});

describe("renderInstructions", () => {
  test("labels each file with its source", () => {
    const root = repo();
    writeFileSync(join(root, "AGENTS.md"), "rules");
    expect(renderInstructions(loadInstructions(root), root)).toBe(
      '<instructions source="AGENTS.md">\nrules\n</instructions>',
    );
  });
});
