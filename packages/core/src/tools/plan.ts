// ExitPlanMode (Claude Code's name, ADR-0010; ADR-0022): in plan mode the model researches
// read-only, then presents its plan with this tool. The user approves it, which switches the
// permission mode so the work can start, or sends the model back to keep planning.
import { obj, str, type Tool } from "./tool";

// What the user decided about a plan. `mode` is the permission mode to continue in.
export type PlanDecision = { approved: true; mode: "default" | "acceptEdits" } | { approved: false; feedback?: string };
export type PlanReviewer = (plan: string) => Promise<PlanDecision>;

export const exitPlanModeTool: Tool<{ plan: string }> = {
  spec: {
    name: "ExitPlanMode",
    description:
      "In plan mode, when you have finished researching and are ready to make changes, present your plan with this tool for the user to approve. Write the plan in Markdown: the steps, the files to change and how you will check the result. Use it only for tasks that need code changes, not for questions. If the user does not approve, keep planning with their feedback.",
    inputSchema: {
      type: "object",
      properties: { plan: { type: "string", description: "The plan, in Markdown" } },
      required: ["plan"],
    },
  },
  parse: (raw) => ({ plan: str(obj(raw), "plan") }),
  // Presenting a plan changes nothing; the user's answer is the approval.
  access: () => ({ kind: "read", paths: [], summary: "Present the plan" }),
  async run(a, ctx) {
    if (!ctx.reviewPlan)
      return {
        content:
          "No one can approve a plan in this run (it is not interactive). Stop here and give the plan as your final answer.",
      };
    const d = await ctx.reviewPlan(a.plan);
    if (d.approved)
      return {
        content: `The user approved the plan. Permission mode is now ${d.mode === "acceptEdits" ? "acceptEdits: file edits no longer ask" : "default: each change asks first"}. Start the work now, following the plan.`,
      };
    return {
      content: `The user did not approve the plan; stay in plan mode and revise it.${d.feedback ? `\nTheir feedback: ${d.feedback}` : ""}`,
    };
  },
};
