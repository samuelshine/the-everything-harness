// Permission engine (ADR-0003, ADR-0008): deny → ask → allow rules in Claude Code's syntax,
// with shell commands parsed first so that rules apply to each simple command. A rule for
// "git status" can therefore never let "git status; rm -rf ~" through.
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { isReadOnly, type PathCheck, unwrap } from "./readonly";
import { commandText, parseShell, type SimpleCommand, type Word } from "./shell";
import { posixShell } from "./tools/bash";
import { type Access, insideWorkspace, type ToolContext } from "./tools/tool";
import { domainRuleMatches } from "./tools/web";

// Mode names mirror Claude Code's --permission-mode (ADR-0010).
export type PermissionMode = "default" | "acceptEdits" | "plan" | "bypassPermissions";
export const PERMISSION_MODES: PermissionMode[] = ["default", "acceptEdits", "plan", "bypassPermissions"];

// "Bash", "Bash(npm test:*)", "Edit(src/**)", "Read(.env)". `pattern` is the text in parentheses.
export type Rule = { tool: string; pattern?: string; source?: string };

export type Decision = {
  behavior: "allow" | "deny" | "ask";
  reason: string;
  suggestion?: string;
  // Allowed because every part of a shell command is read-only, so nothing to checkpoint.
  readOnly?: boolean;
};

export type PermissionConfig = {
  mode: PermissionMode;
  allow: Rule[];
  deny: Rule[];
  ask?: Rule[];
  // Path rules (Edit(src/**)) are relative to the project root; defaults to the first workspace root.
  projectRoot?: string;
  home?: string;
  // Whether commands run in a POSIX shell; defaults to checking for bash.
  posixShell?: boolean;
};

// Directory names inside which writes always ask, so the agent cannot quietly change its
// own settings, hooks, skills or the repository's internals (ADR-0003).
export const PROTECTED_DIRS = [".git", ".teh", ".claude", ".agents"];

const WRITE_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_TOOLS = new Set(["Read", "Grep", "Glob"]);

// Split "Edit, Bash(git add:*) Bash(npm test)" into rule strings, respecting parentheses.
export function splitRuleList(text: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const c of text) {
    if (c === "(") depth++;
    if (c === ")") depth = Math.max(0, depth - 1);
    if (depth === 0 && (c === "," || /\s/.test(c))) {
      if (cur.trim()) out.push(cur.trim());
      cur = "";
      continue;
    }
    cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseRule(spec: string, source?: string): Rule | undefined {
  // "mcp__github__*" is allowed as a tool name: every tool of that MCP server.
  const m = spec.trim().match(/^([A-Za-z_][\w-]*(?:__\*)?)(?:\(([\s\S]*)\))?$/);
  if (!m) return undefined;
  const pattern = m[2]?.trim();
  return {
    tool: m[1] as string,
    ...(pattern && pattern !== "*" ? { pattern } : {}),
    ...(source ? { source } : {}),
  };
}

export function parseRules(specs: string[], source?: string): Rule[] {
  return specs.flatMap((s) => splitRuleList(s).flatMap((r) => parseRule(r, source) ?? []));
}

export function formatRule(r: Rule): string {
  return r.pattern === undefined ? r.tool : `${r.tool}(${r.pattern})`;
}

// --- Bash patterns -------------------------------------------------------------------

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

// "npm test:*" and "npm test *" match npm test with any arguments; a "*" elsewhere matches
// any run of characters. Words are compared after quote removal, separated by one space.
export function bashPatternRegex(pattern: string): RegExp {
  let p = pattern.trim();
  let anyTail = false;
  if (p.endsWith(":*")) {
    p = p.slice(0, -2).trimEnd();
    anyTail = true;
  } else if (p === "*" || p.endsWith(" *")) {
    p = p.slice(0, -1).trimEnd();
    anyTail = true;
  }
  const parsed = parseShell(p);
  const norm = !parsed.opaque && parsed.commands.length === 1 ? commandText(parsed.commands[0] as SimpleCommand) : p;
  const body = norm.split("*").map(escapeRe).join(".*");
  return new RegExp(`^${body}${anyTail ? (body ? "(?: .*)?" : ".*") : ""}$`, "s");
}

// The forms of a simple command a rule may match: as written, and without timeout/nice/time.
function commandForms(c: SimpleCommand): string[] {
  const forms = [commandText(c)];
  if (!c.assigns.length) {
    const inner = unwrap(c.words);
    if (inner.length && inner !== c.words) forms.push(inner.map((w) => w.value).join(" "));
  }
  return forms;
}

// Commands hidden inside another for deny matching: sh -c '…', xargs CMD, env/sudo/nohup CMD,
// find -exec CMD ;. They are never used to allow anything.
function nestedCommands(c: SimpleCommand, depth = 0): SimpleCommand[] {
  if (depth > 3) return [];
  const words = unwrap(c.words);
  const head = words[0]?.value;
  const out: SimpleCommand[] = [];
  const asCommand = (ws: Word[]) => (ws.length ? [{ assigns: [], words: ws, redirects: [] }] : []);
  if ((head === "sh" || head === "bash" || head === "zsh" || head === "dash") && words[1]?.value === "-c") {
    const script = words[2];
    if (script?.literal) {
      const parsed = parseShell(script.value);
      if (!parsed.opaque) for (const n of parsed.commands) out.push(n, ...nestedCommands(n, depth + 1));
    }
  }
  if (head === "env" || head === "sudo" || head === "nohup" || head === "command" || head === "exec") {
    let k = 1;
    while (k < words.length && (words[k]?.value.startsWith("-") || /^\w+=/.test(words[k]?.value ?? ""))) k++;
    out.push(...asCommand(words.slice(k)));
  }
  if (head === "xargs") {
    let k = 1;
    while (k < words.length && words[k]?.value.startsWith("-")) k++;
    out.push(...asCommand(words.slice(k)));
  }
  if (head === "find") {
    for (let k = 1; k < words.length; k++) {
      if (/^-(exec|execdir|ok|okdir)$/.test(words[k]?.value ?? "")) {
        const end = words.findIndex((w, j) => j > k && (w.value === ";" || w.value === "+"));
        out.push(...asCommand(words.slice(k + 1, end < 0 ? undefined : end)));
      }
    }
  }
  return out.flatMap((n) => [n, ...nestedCommands(n, depth + 1)]);
}

function bashRuleMatches(rule: Rule, c: SimpleCommand): boolean {
  if (rule.pattern === undefined) return true;
  const re = bashPatternRegex(rule.pattern);
  return commandForms(c).some((f) => re.test(f));
}

// For a command the parser cannot read, a deny rule still applies if its first word appears
// anywhere as a word. This errs towards blocking.
function opaqueDenyMatches(rule: Rule, command: string): boolean {
  if (rule.pattern === undefined) return true;
  const first = rule.pattern.trim().replace(/:\*$/, "").split(/\s+/)[0]?.replace(/\*.*$/, "");
  if (!first) return true;
  return new RegExp(`(^|[^\\w./-])${escapeRe(first)}([^\\w.-]|$)`).test(command);
}

// --- Path patterns -------------------------------------------------------------------

// Gitignore-like: "//abs" is absolute, "~/x" is under home, anything else is relative to the
// project root; a pattern without "/" matches at any depth; a directory matches its contents.
export function pathRuleMatches(pattern: string, abs: string, root: string, home: string): boolean {
  let p = pattern.trim();
  let base = root;
  if (p.startsWith("//")) {
    base = "/";
    p = p.slice(2);
  } else if (p.startsWith("~/")) {
    base = home;
    p = p.slice(2);
  } else if (p.startsWith("./")) p = p.slice(2);
  else if (p.startsWith("/")) p = p.slice(1);
  if (p.endsWith("/")) p = `${p}**`;
  const rel = relative(base, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  const path = rel.split(sep).join("/");
  const globs = p.includes("/") ? [p, `${p}/**`] : [p, `**/${p}`, `${p}/**`, `**/${p}/**`];
  return globs.some((g) => new Bun.Glob(g).match(path));
}

function pathsMatch(rule: Rule, access: Access, config: PermissionConfig, ctx: ToolContext): boolean {
  if (rule.pattern === undefined) return true;
  if (access.kind === "execute" || access.kind === "external" || access.kind === "network") return false;
  const root = config.projectRoot ?? ctx.workspaceRoots[0] ?? ctx.cwd;
  const home = config.home ?? homedir();
  const pattern = rule.pattern;
  return access.paths.length > 0 && access.paths.some((p) => pathRuleMatches(pattern, p, root, home));
}

// --- Matching ------------------------------------------------------------------------

type Analysis = { opaque: true; reason: string } | { opaque: false; commands: SimpleCommand[] };

function ruleApplies(rule: Rule, tool: string, access: Access, config: PermissionConfig, ctx: ToolContext): boolean {
  if (access.kind === "execute") return false;
  if (rule.tool === tool) return pathsMatch(rule, access, config, ctx);
  // Edit/Write rules cover every file-changing tool, Read rules every reading tool.
  if (WRITE_TOOLS.has(rule.tool) && access.kind === "write") return pathsMatch(rule, access, config, ctx);
  if (rule.tool === "Read" && READ_TOOLS.has(tool) && access.kind === "read") {
    return pathsMatch(rule, access, config, ctx);
  }
  return false;
}

// A deny or ask rule hits a Bash command if it hits any part of it, including commands
// nested in sh -c, xargs or find -exec.
function bashRuleHitsAny(rule: Rule, command: string, a: Analysis): boolean {
  if (a.opaque) return command.trim() === rule.pattern?.trim() || opaqueDenyMatches(rule, command);
  return a.commands.flatMap((c) => [c, ...nestedCommands(c)]).some((c) => bashRuleMatches(rule, c));
}

function firstHit(
  rules: Rule[],
  tool: string,
  access: Access,
  config: PermissionConfig,
  ctx: ToolContext,
  a: Analysis | undefined,
): Rule | undefined {
  return rules.find((r) => {
    if (access.kind === "external") return r.pattern === undefined && mcpRuleMatches(r.tool, tool);
    if (access.kind === "network") return r.tool === tool && domainRuleMatches(r.pattern, access.host);
    if (access.kind === "execute") return r.tool === tool && a !== undefined && bashRuleHitsAny(r, access.command, a);
    return ruleApplies(r, tool, access, config, ctx);
  });
}

// "mcp__github" and "mcp__github__*" match every tool of that server; otherwise the exact name.
export function mcpRuleMatches(ruleTool: string, tool: string): boolean {
  if (ruleTool === tool) return true;
  const server = ruleTool.endsWith("__*") ? ruleTool.slice(0, -3) : ruleTool;
  return /^mcp__[^_]/.test(server) && !server.slice(5).includes("__") && tool.startsWith(`${server}__`);
}

export function protectedPath(abs: string): string | undefined {
  const parts = abs.split(/[\\/]/);
  return PROTECTED_DIRS.find((d) => parts.includes(d));
}

function readCheck(ctx: ToolContext, config: PermissionConfig): PathCheck {
  const roots = [...ctx.workspaceRoots, ...(ctx.readRoots ?? [])];
  const denyReads = config.deny.filter((r) => r.tool === "Read" && r.pattern !== undefined);
  const root = config.projectRoot ?? ctx.workspaceRoots[0] ?? ctx.cwd;
  const home = config.home ?? homedir();
  return {
    cwd: ctx.cwd,
    home,
    readable: (abs) =>
      insideWorkspace(abs, ctx, roots) && !denyReads.some((r) => pathRuleMatches(r.pattern as string, abs, root, home)),
  };
}

// Whether every part of a command is allowed without asking, and why.
function commandAllowed(
  a: Analysis,
  command: string,
  config: PermissionConfig,
  ctx: ToolContext,
  readOnlyOnly: boolean,
): { ok: true; reason: string; readOnly: boolean } | { ok: false; why: string } {
  if (!readOnlyOnly) {
    const exact = config.allow.find(
      (r) => r.tool === "Bash" && r.pattern !== undefined && r.pattern.trim() === command.trim(),
    );
    if (exact) return { ok: true, reason: `allowed by rule ${formatRule(exact)}`, readOnly: false };
    const whole = config.allow.find((r) => r.tool === "Bash" && r.pattern === undefined);
    if (whole) return { ok: true, reason: `allowed by rule ${formatRule(whole)}`, readOnly: false };
  }
  if (a.opaque) return { ok: false, why: `the shell syntax needs a closer look (${a.reason})` };
  if (!(config.posixShell ?? posixShell()))
    return { ok: false, why: "commands run in cmd.exe, which teh does not parse" };
  const check = readCheck(ctx, config);
  // cd changes where later relative paths point.
  let cwd = ctx.cwd;
  const reasons = new Set<string>();
  for (const c of a.commands) {
    const pc = { ...check, cwd };
    const ro = isReadOnly(c, pc);
    if (ro.ok) {
      reasons.add("read-only");
      const words = unwrap(c.words);
      if (words[0]?.value === "cd" && words[1]) cwd = resolve(cwd, words[1].value);
      continue;
    }
    if (readOnlyOnly) return { ok: false, why: ro.why };
    const rule = config.allow.find((r) => r.tool === "Bash" && r.pattern !== undefined && bashRuleMatches(r, c));
    if (!rule) return { ok: false, why: ro.why };
    // A rule allows the command, not arbitrary file writes through redirection.
    const writes = c.redirects.filter((r) => /^\d*(>|>>|&>|&>>|>\|)$/.test(r.op) && r.target.value !== "/dev/null");
    for (const w of writes) {
      const abs = resolve(cwd, w.target.value);
      if (!w.target.literal || !insideWorkspace(abs, ctx) || protectedPath(abs))
        return { ok: false, why: `writes to ${w.target.value}` };
    }
    reasons.add(`rule ${formatRule(rule)}`);
  }
  const list = [...reasons];
  const readOnly = list.length === 1 && list[0] === "read-only";
  return { ok: true, reason: readOnly ? "read-only command" : `allowed: ${list.join(", ")}`, readOnly };
}

// A rule the user could add to allow this action next time.
export function suggestRule(tool: string, access: Access): string | undefined {
  if (access.kind === "external") return tool;
  if (access.kind === "network")
    return tool === "WebFetch" ? `WebFetch(domain:${access.host.replace(/:\d+$/, "")})` : tool;
  if (access.kind === "write") return tool === "Write" || tool === "Edit" ? "Edit" : tool;
  if (access.kind !== "execute") return undefined;
  const a = parseShell(access.command);
  if (a.opaque || a.commands.length !== 1) return `Bash(${access.command})`;
  const words = unwrap((a.commands[0] as SimpleCommand).words);
  const [first, second] = words;
  if (!first) return undefined;
  const sub = second && /^[a-z][\w:-]*$/.test(second.value) ? ` ${second.value}` : "";
  return `Bash(${first.value}${sub}:*)`;
}

export function decide(tool: string, access: Access, config: PermissionConfig, ctx: ToolContext): Decision {
  const analysis: Analysis | undefined = access.kind === "execute" ? parseShell(access.command) : undefined;

  const denied = firstHit(config.deny, tool, access, config, ctx, analysis);
  if (denied) return { behavior: "deny", reason: `blocked by rule ${formatRule(denied)}` };
  if (config.mode === "bypassPermissions") return { behavior: "allow", reason: "bypassPermissions mode" };

  // Only offer a rule where adding it would actually allow the action.
  const ask = (reason: string, suggest = false): Decision => {
    const suggestion = suggest ? suggestRule(tool, access) : undefined;
    return { behavior: "ask", reason, ...(suggestion ? { suggestion } : {}) };
  };
  const asked = firstHit(config.ask ?? [], tool, access, config, ctx, analysis);

  if (access.kind === "external") {
    if (asked) return ask(`rule ${formatRule(asked)} asks first`);
    const allowed = firstHit(config.allow, tool, access, config, ctx, undefined);
    // MCP tools may change anything, so plan mode runs only the ones a rule allows.
    if (config.mode === "plan")
      return allowed
        ? { behavior: "allow", reason: `allowed by rule ${formatRule(allowed)}` }
        : { behavior: "deny", reason: "plan mode is read-only; an allow rule can let this MCP tool run" };
    if (allowed) return { behavior: "allow", reason: `allowed by rule ${formatRule(allowed)}` };
    return ask(`MCP tool from ${access.server}`, true);
  }

  // The network (ADR-0021): nothing local changes, so plan mode is no different, but a request
  // can carry data out, so it asks unless a rule allows that domain or tool.
  if (access.kind === "network") {
    if (asked) return ask(`rule ${formatRule(asked)} asks first`);
    const allowed = firstHit(config.allow, tool, access, config, ctx, undefined);
    if (allowed) return { behavior: "allow", reason: `allowed by rule ${formatRule(allowed)}` };
    return ask(`network request to ${access.host}`, true);
  }

  if (access.kind === "read") {
    if (asked) return ask(`rule ${formatRule(asked)} asks first`);
    if (access.paths.every((p) => insideWorkspace(p, ctx)))
      return { behavior: "allow", reason: "read inside workspace" };
    if (access.paths.every((p) => insideWorkspace(p, ctx, [...ctx.workspaceRoots, ...(ctx.readRoots ?? [])])))
      return { behavior: "allow", reason: "read inside a skill folder" };
    return ask("read outside the workspace");
  }

  if (access.kind === "execute") {
    const a = analysis as Analysis;
    if (asked) return ask(`rule ${formatRule(asked)} asks first`);
    const verdict = commandAllowed(a, access.command, config, ctx, config.mode === "plan");
    if (config.mode === "plan") {
      return verdict.ok
        ? { behavior: "allow", reason: verdict.reason, readOnly: verdict.readOnly }
        : { behavior: "deny", reason: `plan mode is read-only (${verdict.why})` };
    }
    if (verdict.ok) return { behavior: "allow", reason: verdict.reason, readOnly: verdict.readOnly };
    return ask(`shell command (${verdict.why})`, true);
  }

  if (config.mode === "plan") return { behavior: "deny", reason: "plan mode is read-only" };
  if (asked) return ask(`rule ${formatRule(asked)} asks first`);
  if (!access.paths.every((p) => insideWorkspace(p, ctx))) return ask("write outside the workspace");
  const guarded = access.paths.map(protectedPath).find(Boolean);
  if (guarded) return ask(`${guarded}/ is protected`);
  const allowed = firstHit(config.allow, tool, access, config, ctx, undefined);
  if (allowed) return { behavior: "allow", reason: `allowed by rule ${formatRule(allowed)}` };
  if (config.mode === "acceptEdits") return { behavior: "allow", reason: "acceptEdits mode" };
  return ask("file change", true);
}
