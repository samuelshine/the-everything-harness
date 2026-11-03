// Interim permission engine (ADR-0008: ask before every change). The full model,
// including a parsed shell AST and the OS sandbox, comes with ADR-0003. Until then
// Bash rules match whole commands exactly; prefix matching is deliberately absent
// because `git status; rm -rf ~` would match a "git status" prefix.
import { type Access, insideWorkspace, type ToolContext } from "./tools/tool";

// Mode names mirror Claude Code's --permission-mode (ADR-0010).
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

export type Rule = { tool: string; command?: string };

export type Decision = { behavior: "allow" | "deny" | "ask"; reason: string };

export type PermissionConfig = { mode: PermissionMode; allow: Rule[]; deny: Rule[] };

// "Edit", "Bash", "Bash(npm test)". Several rules may be given comma- or space-separated,
// but a parenthesised command may contain spaces.
export function parseRules(specs: string[]): Rule[] {
  const rules: Rule[] = [];
  for (const spec of specs) {
    for (const m of spec.matchAll(/([A-Za-z_][\w-]*)(?:\(([^)]*)\))?/g)) {
      const tool = m[1] as string;
      const command = m[2]?.trim();
      rules.push(command ? { tool, command } : { tool });
    }
  }
  return rules;
}

export function formatRule(r: Rule): string {
  return r.command === undefined ? r.tool : `${r.tool}(${r.command})`;
}

function matches(rule: Rule, tool: string, access: Access): boolean {
  if (rule.tool !== tool) return false;
  if (rule.command === undefined) return true;
  return access.kind === "execute" && access.command.trim() === rule.command;
}

export function decide(tool: string, access: Access, config: PermissionConfig, ctx: ToolContext): Decision {
  const denied = config.deny.find((r) => matches(r, tool, access));
  if (denied) return { behavior: "deny", reason: `blocked by rule ${formatRule(denied)}` };

  if (access.kind === "read") {
    if (access.paths.every((p) => insideWorkspace(p, ctx)))
      return { behavior: "allow", reason: "read inside workspace" };
    return { behavior: config.mode === "bypassPermissions" ? "allow" : "ask", reason: "read outside the workspace" };
  }

  if (config.mode === "plan") return { behavior: "deny", reason: "plan mode is read-only" };
  if (config.mode === "bypassPermissions") return { behavior: "allow", reason: "bypassPermissions mode" };

  const outside = access.kind === "write" && !access.paths.every((p) => insideWorkspace(p, ctx));
  if (outside) return { behavior: "ask", reason: "write outside the workspace" };

  const allowed = config.allow.find((r) => matches(r, tool, access));
  if (allowed) return { behavior: "allow", reason: `allowed by rule ${formatRule(allowed)}` };
  if (config.mode === "acceptEdits" && access.kind === "write")
    return { behavior: "allow", reason: "acceptEdits mode" };

  return { behavior: "ask", reason: access.kind === "write" ? "file change" : "shell command" };
}
