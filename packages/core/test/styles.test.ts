import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { systemPrompt } from "../src/prompt";
import { findStyle, loadStyles } from "../src/styles";
import { tempDir } from "./helpers";

const write = (dir: string, name: string, text: string) => {
  mkdirSync(join(dir, "output-styles"), { recursive: true });
  writeFileSync(join(dir, "output-styles", `${name}.md`), text);
};

describe("output styles", () => {
  test("built-ins are always there", () => {
    const { styles } = loadStyles(tempDir(), tempDir(), tempDir());
    expect(styles.map((s) => s.name)).toEqual(["default", "explanatory", "learning"]);
    expect(findStyle(styles, "Explanatory")?.name).toBe("explanatory");
  });

  test("Claude Code style files load; keep-coding-instructions defaults to false", () => {
    const home = tempDir();
    write(join(home, ".claude"), "pirate", "---\nname: Pirate\ndescription: Talk like a pirate\n---\nSay arr.\n");
    write(join(home, ".claude"), "reviewer", "---\nkeep-coding-instructions: true\n---\nReview carefully.\n");
    const { styles } = loadStyles(tempDir(), tempDir(), home);
    expect(findStyle(styles, "pirate")).toMatchObject({
      name: "Pirate",
      description: "Talk like a pirate",
      body: "Say arr.",
      keepCodingInstructions: false,
      source: "user",
    });
    expect(findStyle(styles, "reviewer")?.keepCodingInstructions).toBe(true);
  });

  test("a user can replace a built-in; a project can replace neither", () => {
    const teh = tempDir();
    const root = tempDir();
    write(teh, "learning", "My own learning style.");
    write(join(root, ".claude"), "learning", "Repo learning style.");
    write(join(root, ".claude"), "explanatory", "Repo explanatory style.");
    write(join(root, ".teh"), "team", "---\ndescription: Team style\n---\nUse the team voice.");
    const { styles } = loadStyles(teh, root, tempDir());
    expect(findStyle(styles, "learning")).toMatchObject({ body: "My own learning style.", source: "user" });
    expect(findStyle(styles, "explanatory")?.source).toBe("builtin");
    expect(findStyle(styles, "team")?.source).toBe("project");
  });

  test("an empty style is reported, not loaded", () => {
    const home = tempDir();
    write(join(home, ".claude"), "empty", "---\nname: empty\n---\n");
    const { styles, problems } = loadStyles(tempDir(), tempDir(), home);
    expect(findStyle(styles, "empty")).toBeUndefined();
    expect(problems[0]?.message).toContain("needs instructions");
  });
});

describe("system prompt with a style", () => {
  const env = {
    cwd: "/w",
    projectRoot: "/w",
    platform: "linux",
    date: "2026-11-04",
    isGitRepo: true,
    instructions: "",
  };

  test("the default style is the base prompt", () => {
    const p = systemPrompt(env);
    expect(p).toContain("Investigate before acting");
    expect(p).toContain("reply with a short summary");
    expect(p).not.toContain("<output_style");
  });

  test("a style replaces the response format and keeps safety guidance", () => {
    const p = systemPrompt({ ...env, style: { name: "pirate", body: "Say arr.", keepCodingInstructions: false } });
    expect(p).toContain('<output_style name="pirate">');
    expect(p).toContain("Say arr.");
    expect(p).not.toContain("Investigate before acting");
    expect(p).not.toContain("reply with a short summary");
    expect(p).toContain("If one is denied, do not retry it unchanged");
    expect(p).toContain("Do not invent results");
    const kept = systemPrompt({ ...env, style: { name: "x", body: "Explain.", keepCodingInstructions: true } });
    expect(kept).toContain("Investigate before acting");
  });
});
