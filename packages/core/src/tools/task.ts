// The Task tool (ADR-0019): hand a search to an explore subagent. It runs on its own context,
// usually on a smaller model, with read-only tools, and only its final report comes back, so
// a long hunt through the codebase does not fill the main conversation.
import { obj, str, type Tool, type ToolResult } from "./tool";

export type ExploreRequest = { description: string; prompt: string; signal?: AbortSignal };

export function taskTool(
  run: (req: ExploreRequest) => Promise<ToolResult>,
): Tool<{ description: string; prompt: string }> {
  return {
    spec: {
      name: "Task",
      description:
        "Launch a read-only explore subagent to search the codebase and report back. Use it for open-ended questions that would take several Glob, Grep and Read calls, such as where something is defined, how a feature works, or which files a change touches. It cannot edit files. Give it a complete, self-contained task; it does not see this conversation. You get back only its report, so your context stays small.",
      inputSchema: {
        type: "object",
        properties: {
          description: { type: "string", description: "A short (3-5 word) label for the task" },
          prompt: {
            type: "string",
            description: "The full task for the subagent, including what to report back",
          },
        },
        required: ["description", "prompt"],
      },
    },
    parse(raw) {
      const o = obj(raw);
      const prompt = str(o, "prompt");
      const description = (str(o, "description", true) ?? prompt).replace(/\s+/g, " ").trim().slice(0, 60);
      return { description, prompt };
    },
    access: (a) => ({ kind: "read", paths: [], summary: `Explore ${a.description}` }),
    run: (a, ctx) => run({ ...a, ...(ctx.signal ? { signal: ctx.signal } : {}) }),
  };
}

export const EXPLORE_TOOLS = ["Read", "Glob", "Grep", "Bash"];

export const EXPLORE_BRIEF = `You are an explore subagent working for another agent. You can only read: use Glob, Grep and Read, and Bash for read-only commands such as git log. You cannot change anything.
Do the task below, then reply with a concise report: what you found, with file paths and line numbers, and anything you could not find. Your report is all the other agent will see.`;
