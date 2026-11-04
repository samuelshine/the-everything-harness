// Output styles (ADR-0015): Markdown files that change how teh talks and works for a whole
// session, in Claude Code's format, so existing ~/.claude/output-styles files work as they are.
// A style replaces the base prompt's response-format guidance; it also drops the coding
// guidance unless its frontmatter says `keep-coding-instructions: true` (Claude Code's
// default). Safety guidance about approvals and honest reporting is always kept.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { markdownFiles, type SkillProblem, type SkillSource, skillRoots, splitFrontmatter } from "./skills";

export type OutputStyle = {
  name: string;
  description: string;
  // Text placed in the system prompt for the whole session.
  body: string;
  keepCodingInstructions: boolean;
  source: SkillSource | "builtin";
  path?: string;
};

export const DEFAULT_STYLE = "default";

// Built-in styles. Names match Claude Code's, so a style picked there also works here.
export const BUILTIN_STYLES: OutputStyle[] = [
  {
    name: "default",
    description: "Get the work done and report briefly",
    body: "",
    keepCodingInstructions: true,
    source: "builtin",
  },
  {
    name: "explanatory",
    description: "Do the work and explain the reasoning behind it as you go",
    keepCodingInstructions: true,
    source: "builtin",
    body: `Explain as you work, so the user understands this codebase better afterwards.
- Before a significant step, and after finishing, add a short note headed "Insight" with two or three points: why the code is shaped this way, the pattern or convention you are following, a trade-off you weighed, or something a newcomer would miss.
- Keep insights specific to this code and this change. Skip general programming advice.
- Explanations come in addition to the work, not instead of it: still finish the task.`,
  },
  {
    name: "learning",
    description: "Pair with the user: they write small key pieces, you guide and review",
    keepCodingInstructions: true,
    source: "builtin",
    body: `Work as a pair-programming teacher, so the user learns by doing.
- Do routine parts yourself (boilerplate, wiring, repetitive edits).
- For one or two small, meaningful pieces per task, such as a function body, a condition, or a design choice, ask the user to write it. Put a \`TODO(human)\` comment at that exact spot, then explain what it should do, its inputs and outputs, and any constraint to respect. Stop there and wait for them.
- When they have written it, review it kindly and concretely, and fix nothing silently.
- Add short "Insight" notes, as in the explanatory style, when they help.`,
  },
];

export type StyleSet = { styles: OutputStyle[]; problems: SkillProblem[] };

// User files first, then built-ins, then project files. A style whose name is already taken is
// skipped, so a user can replace a built-in style but a repo can replace neither.
export function loadStyles(tehHome: string, projectRoot: string, home = homedir()): StyleSet {
  const styles = new Map<string, OutputStyle>();
  const problems: SkillProblem[] = [];
  const addBuiltins = () => {
    for (const b of BUILTIN_STYLES) if (!styles.has(b.name)) styles.set(b.name, b);
  };
  for (const root of skillRoots(tehHome, projectRoot, home)) {
    if (root.source === "project") addBuiltins();
    if (root.agentsDir) continue;
    for (const path of markdownFiles(join(root.base, "output-styles"))) {
      let text: string;
      try {
        text = readFileSync(path, "utf8");
      } catch (e) {
        problems.push({ path, message: `cannot read: ${(e as Error).message}` });
        continue;
      }
      const { meta, body, error } = splitFrontmatter(text);
      if (error) {
        problems.push({ path, message: error });
        continue;
      }
      const name = (typeof meta.name === "string" && meta.name.trim() ? meta.name : basename(path, ".md")).trim();
      const key = name.toLowerCase();
      if (styles.has(key)) continue;
      if (!body.trim()) {
        problems.push({ path, message: "an output style needs instructions after the frontmatter" });
        continue;
      }
      styles.set(key, {
        name,
        description: typeof meta.description === "string" ? meta.description.trim() : "",
        body: body.trim(),
        keepCodingInstructions: meta["keep-coding-instructions"] === true,
        source: root.source,
        path,
      });
    }
  }
  addBuiltins();
  return { styles: [...styles.values()], problems };
}

export function findStyle(styles: OutputStyle[], name: string): OutputStyle | undefined {
  const key = name.trim().toLowerCase();
  return styles.find((s) => s.name.toLowerCase() === key);
}
