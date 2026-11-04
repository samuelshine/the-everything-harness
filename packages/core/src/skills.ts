// Skills and slash commands (ADR-0015): Markdown files with YAML frontmatter, in the
// Agent Skills format and Claude Code's command format, so existing ones work unchanged.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { splitRuleList } from "./permissions";

export type SkillSource = "user" | "project";

export type Skill = {
  name: string;
  description: string;
  kind: "skill" | "command";
  source: SkillSource;
  // The Markdown file, and the directory relative references resolve against.
  path: string;
  dir: string;
  // Body without frontmatter.
  body: string;
  argumentHint?: string;
  // Listed for the model and loadable through the Skill tool.
  modelInvocable: boolean;
  // Runs with /name.
  userInvocable: boolean;
  // A model role (ADR-0014) the skill asks for; not acted on until roles exist.
  model?: string;
  // Permission rules granted while the skill is loaded (ADR-0003). Project skills grant
  // nothing until the folder is trusted.
  allowedTools?: string[];
};

export type SkillProblem = { path: string; message: string };

export type SkillSet = { skills: Skill[]; problems: SkillProblem[] };

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Search order: user level before project level, so a repo cannot shadow a user's skill.
export function skillRoots(tehHome: string, projectRoot: string, home = homedir()) {
  return [
    { source: "user" as const, base: tehHome, agentsDir: false },
    { source: "user" as const, base: join(home, ".claude"), agentsDir: false },
    { source: "project" as const, base: join(projectRoot, ".teh"), agentsDir: false },
    { source: "project" as const, base: join(projectRoot, ".agents"), agentsDir: true },
    { source: "project" as const, base: join(projectRoot, ".claude"), agentsDir: false },
  ];
}

export function loadSkills(tehHome: string, projectRoot: string, home = homedir()): SkillSet {
  const skills = new Map<string, Skill>();
  const problems: SkillProblem[] = [];
  const add = (s: Skill) => {
    if (!skills.has(s.name)) skills.set(s.name, s);
  };
  for (const root of skillRoots(tehHome, projectRoot, home)) {
    for (const dir of subdirs(join(root.base, "skills"))) {
      const file = join(dir, "SKILL.md");
      if (!existsSync(file)) continue;
      const s = parseFile(file, "skill", root.source, problems);
      if (s) add(s);
    }
    if (root.agentsDir) continue; // .agents/ holds skills only (Agent Skills spec)
    const commands = join(root.base, "commands");
    for (const f of files(commands)) {
      const s = parseFile(f, "command", root.source, problems);
      if (s) add(s);
    }
  }
  return { skills: [...skills.values()].sort((a, b) => a.name.localeCompare(b.name)), problems };
}

function parseFile(
  path: string,
  kind: Skill["kind"],
  source: SkillSource,
  problems: SkillProblem[],
): Skill | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    problems.push({ path, message: `cannot read: ${(e as Error).message}` });
    return undefined;
  }
  const { meta, body, error } = splitFrontmatter(text);
  if (error) {
    problems.push({ path, message: error });
    return undefined;
  }
  const fallbackName = kind === "skill" ? basename(join(path, "..")) : basename(path, ".md");
  const name = typeof meta.name === "string" && meta.name ? meta.name : fallbackName;
  if (!NAME.test(name)) {
    problems.push({ path, message: `name "${name}" must be lowercase letters, digits and hyphens (max 64)` });
    return undefined;
  }
  const firstLine = body.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? "";
  const description = typeof meta.description === "string" ? meta.description.trim() : firstLine.trim();
  if (kind === "skill" && !description) {
    problems.push({ path, message: "a skill needs a description so the model knows when to use it" });
    return undefined;
  }
  const allowed = meta["allowed-tools"];
  const allowedTools = Array.isArray(allowed)
    ? allowed.map(String)
    : typeof allowed === "string"
      ? splitRuleList(allowed)
      : undefined;
  return {
    name,
    description,
    kind,
    source,
    path,
    dir: join(path, ".."),
    body: body.trim(),
    ...(typeof meta["argument-hint"] === "string" ? { argumentHint: meta["argument-hint"] } : {}),
    // Commands are user-invoked only, as in Claude Code.
    modelInvocable: kind === "skill" && meta["disable-model-invocation"] !== true,
    userInvocable: meta["user-invocable"] !== false,
    ...(typeof meta.model === "string" ? { model: meta.model } : {}),
    ...(allowedTools ? { allowedTools } : {}),
  };
}

export function splitFrontmatter(text: string): { meta: Record<string, unknown>; body: string; error?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { meta: {}, body: text };
  try {
    const meta = Bun.YAML.parse(m[1] ?? "");
    if (meta === null || meta === undefined) return { meta: {}, body: m[2] ?? "" };
    if (typeof meta !== "object" || Array.isArray(meta))
      return { meta: {}, body: text, error: "frontmatter is not a map" };
    return { meta: meta as Record<string, unknown>, body: m[2] ?? "" };
  } catch (e) {
    return { meta: {}, body: text, error: `invalid frontmatter: ${(e as Error).message}` };
  }
}

// "/name rest of prompt" → { name, args }. A leading path like "/tmp/x" is not a command.
export function parseSlash(prompt: string): { name: string; args: string } | undefined {
  const m = prompt.trimStart().match(/^\/([a-z0-9][a-z0-9-]*)(?:\s+([\s\S]*))?$/);
  return m?.[1] ? { name: m[1], args: (m[2] ?? "").trim() } : undefined;
}

// Split arguments for $1, $2…: whitespace-separated, with "double" or 'single' quotes.
export function splitArgs(args: string): string[] {
  const out: string[] = [];
  for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

// The user message a skill or command turns into.
export function expandSkill(skill: Skill, args: string): string {
  const positional = splitArgs(args);
  let body = skill.body;
  const usesArgs = /\$ARGUMENTS|\$\d/.test(body);
  body = body.replace(/\$ARGUMENTS/g, args).replace(/\$(\d+)/g, (_, i) => positional[Number(i) - 1] ?? "");
  if (!usesArgs && args) body += `\n\nARGUMENTS: ${args}`;
  if (skill.kind === "command") return body;
  return `Use the "${skill.name}" skill for this request. Its files are in ${skill.dir}; paths it mentions are relative to that directory.\n\n${body}`;
}

// Names close to `name`, for "did you mean".
export function similarNames(name: string, skills: Skill[]): string[] {
  return skills
    .filter((s) => s.userInvocable)
    .map((s) => ({ s: s.name, d: distance(name, s.name) }))
    .filter((x) => x.d <= Math.max(2, Math.floor(name.length / 3)) || x.s.startsWith(name) || name.startsWith(x.s))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .map((x) => x.s);
}

function distance(a: string, b: string): number {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0] ?? 0;
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = dp[j] ?? 0;
      dp[j] = Math.min((dp[j] ?? 0) + 1, (dp[j - 1] ?? 0) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[b.length] ?? 0;
}

// The listing for the system prompt, within a character budget. Skills that do not fit are
// still loadable by name through the Skill tool.
export function skillListing(skills: Skill[], budgetChars: number): { text: string; omitted: number } {
  const lines: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const s of skills.filter((x) => x.modelInvocable)) {
    const line = `- ${s.name}: ${s.description.replace(/\s+/g, " ")}`;
    if (used + line.length > budgetChars) {
      omitted++;
      continue;
    }
    lines.push(line);
    used += line.length + 1;
  }
  return { text: lines.join("\n"), omitted };
}

function subdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => join(dir, n))
    .filter((p) => {
      try {
        return statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
}

function files(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((n) => n.endsWith(".md"))
    .map((n) => join(dir, n));
}
