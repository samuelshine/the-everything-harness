import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expandSkill, loadSkills, parseSlash, similarNames, skillListing, splitArgs } from "../src/skills";
import { tempDir } from "./helpers";

function put(root: string, rel: string, text: string) {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text);
}

const skillMd = (name: string, description: string, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nDo the ${name} thing.\n`;

function layout() {
  const tehHome = tempDir("teh-home-");
  const home = tempDir("home-");
  const project = tempDir("proj-");
  put(home, ".claude/skills/human/SKILL.md", skillMd("human", "Rewrite prose so it reads as human."));
  put(project, ".claude/skills/human/SKILL.md", skillMd("human", "A repo trying to shadow the user's skill."));
  put(
    project,
    ".agents/skills/deploy/SKILL.md",
    skillMd("deploy", "Deploy the app.", "disable-model-invocation: true\n"),
  );
  put(project, ".claude/commands/review.md", "Review the diff for $1 and focus on $2.\n");
  put(tehHome, "commands/standup.md", "---\nargument-hint: <team>\n---\nWrite a standup for $ARGUMENTS.\n");
  put(project, ".claude/skills/Bad Name/SKILL.md", skillMd("Bad Name", "x"));
  put(project, ".claude/skills/broken/SKILL.md", "---\nname: [unclosed\n---\nbody");
  put(project, ".claude/skills/nodesc/SKILL.md", "---\nname: nodesc\n---\n");
  return { tehHome, home, project, set: loadSkills(tehHome, project, home) };
}

describe("loadSkills", () => {
  test("finds skills and commands at user and project level; the user's copy wins", () => {
    const { set } = layout();
    expect(set.skills.map((s) => [s.name, s.kind, s.source])).toEqual([
      ["deploy", "skill", "project"],
      ["human", "skill", "user"],
      ["review", "command", "project"],
      ["standup", "command", "user"],
    ]);
    const by = (n: string) => set.skills.find((s) => s.name === n);
    expect(by("human")?.description).toBe("Rewrite prose so it reads as human.");
    expect(by("deploy")).toMatchObject({ modelInvocable: false, userInvocable: true });
    expect(by("review")).toMatchObject({
      modelInvocable: false,
      description: "Review the diff for $1 and focus on $2.",
    });
    expect(by("standup")?.argumentHint).toBe("<team>");
  });

  test("reports invalid files instead of failing", () => {
    const messages = layout().set.problems.map((p) => p.message);
    expect(messages).toContainEqual(expect.stringContaining("lowercase"));
    expect(messages).toContainEqual(expect.stringContaining("invalid frontmatter"));
    expect(messages).toContainEqual(expect.stringContaining("needs a description"));
  });
});

describe("slash invocation", () => {
  test("parses /name and leaves paths alone", () => {
    expect(parseSlash("/human make this better")).toEqual({ name: "human", args: "make this better" });
    expect(parseSlash("  /review")).toEqual({ name: "review", args: "" });
    expect(parseSlash("/tmp/x is weird")).toBeUndefined();
    expect(parseSlash("fix /human")).toBeUndefined();
  });

  test("expands arguments", () => {
    const { set } = layout();
    const by = (n: string) => set.skills.find((s) => s.name === n);
    expect(expandSkill(by("review") as never, 'auth "error handling"')).toBe(
      "Review the diff for auth and focus on error handling.",
    );
    expect(expandSkill(by("standup") as never, "platform")).toBe("Write a standup for platform.");
    const human = expandSkill(by("human") as never, "README.md");
    expect(human).toStartWith('Use the "human" skill');
    expect(human).toContain(by("human")?.dir as string);
    expect(human).toEndWith("Do the human thing.\n\nARGUMENTS: README.md");
  });

  test("splits quoted arguments and suggests near names", () => {
    expect(splitArgs(`a "b c" 'd e' f`)).toEqual(["a", "b c", "d e", "f"]);
    expect(similarNames("humna", layout().set.skills)).toContain("human");
  });

  test("the listing respects its budget and only lists model-invocable skills", () => {
    const { set } = layout();
    expect(skillListing(set.skills, 4000).text).toBe("- human: Rewrite prose so it reads as human.");
    expect(skillListing(set.skills, 10)).toEqual({ text: "", omitted: 1 });
  });
});
