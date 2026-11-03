// The Skill tool (ADR-0015): the model loads a skill's instructions when a task matches its
// description. Only names and descriptions sit in the system prompt until then.
import { expandSkill, type Skill, similarNames } from "../skills";
import { obj, str, type Tool, ToolInputError } from "./tool";

// `loaded` holds skills already in the conversation (e.g. run with /name), so they are not sent twice.
export function skillTool(skills: Skill[], loaded = new Set<string>()): Tool<{ name: string; args: string }> {
  const usable = skills.filter((s) => s.modelInvocable);
  return {
    spec: {
      name: "Skill",
      description:
        "Load a skill: instructions for a specific kind of task. Call it before starting a task that matches a skill's description, then follow the instructions it returns. Skill files it mentions can be read with Read.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "The skill's name, e.g. human" },
          args: { type: "string", description: "Optional arguments for the skill" },
        },
        required: ["name"],
      },
    },
    parse(raw) {
      const o = obj(raw);
      const name = str(o, "name").replace(/^\//, "");
      const args = typeof o.args === "string" ? o.args : "";
      if (!usable.some((s) => s.name === name)) {
        const near = similarNames(name, usable);
        throw new ToolInputError(
          `no skill named "${name}"${near.length ? `; did you mean ${near.join(", ")}?` : ""}. Available: ${usable.map((s) => s.name).join(", ") || "none"}`,
        );
      }
      return { name, args };
    },
    access: (a) => ({ kind: "read", paths: [], summary: `Use skill ${a.name}` }),
    async run(a) {
      if (loaded.has(a.name)) {
        return {
          content: `The "${a.name}" skill is already loaded earlier in this conversation; follow those instructions.`,
        };
      }
      loaded.add(a.name);
      const skill = usable.find((s) => s.name === a.name) as Skill;
      return { content: expandSkill(skill, a.args) };
    },
  };
}
