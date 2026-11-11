// Hooks (ADR-0016): shell commands that run on lifecycle events, in Claude Code's format, so
// existing hook scripts work unchanged. A hook reads one JSON object on stdin and answers
// with its exit code (0 ok, 2 block, other = non-blocking error) and, optionally, JSON on stdout.
import { shellArgv } from "./tools/bash";

export const HOOK_EVENTS = [
  "PreToolUse",
  "PostToolUse",
  "UserPromptSubmit",
  "Stop",
  "SessionStart",
  "SessionEnd",
  "Notification",
  "PreCompact",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

// Claude Code events teh does not fire yet. Accepted in settings so a shared file loads cleanly.
export const LATER_HOOK_EVENTS = ["SubagentStop"] as const;

export type HookCommand = { command: string; timeoutSec?: number; source: string };
export type HookGroup = { matcher?: string; hooks: HookCommand[] };
export type HookConfig = Partial<Record<HookEvent, HookGroup[]>>;

const DEFAULT_TIMEOUT_SEC = 60;

// Parse the "hooks" section of one settings file. Problems are returned, not thrown.
export function parseHooks(raw: unknown, source: string): { config: HookConfig; problems: string[] } {
  const config: HookConfig = {};
  const problems: string[] = [];
  if (raw === undefined) return { config, problems };
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    return { config, problems: ["hooks must be an object keyed by event name"] };
  for (const [event, groups] of Object.entries(raw)) {
    if ((LATER_HOOK_EVENTS as readonly string[]).includes(event)) continue;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      problems.push(`unknown hook event "${event}"; known: ${HOOK_EVENTS.join(", ")}`);
      continue;
    }
    if (!Array.isArray(groups)) {
      problems.push(`hooks.${event} must be a list of {"matcher", "hooks"} groups`);
      continue;
    }
    const parsed: HookGroup[] = [];
    for (const g of groups as unknown[]) {
      const group = g as { matcher?: unknown; hooks?: unknown };
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) {
        problems.push(`hooks.${event}: each group needs a "hooks" list`);
        continue;
      }
      if (group.matcher !== undefined && typeof group.matcher !== "string") {
        problems.push(`hooks.${event}: "matcher" must be a string`);
        continue;
      }
      if (typeof group.matcher === "string" && group.matcher && !matcherRegex(group.matcher)) {
        problems.push(`hooks.${event}: matcher "${group.matcher}" is not a valid pattern`);
        continue;
      }
      const hooks: HookCommand[] = [];
      for (const h of group.hooks as unknown[]) {
        const hook = h as { type?: unknown; command?: unknown; timeout?: unknown };
        if (hook?.type !== "command" || typeof hook.command !== "string" || !hook.command.trim()) {
          problems.push(`hooks.${event}: only {"type": "command", "command": "..."} hooks are supported`);
          continue;
        }
        const timeout = typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : undefined;
        hooks.push({ command: hook.command, source, ...(timeout ? { timeoutSec: timeout } : {}) });
      }
      if (hooks.length)
        parsed.push({
          ...(typeof group.matcher === "string" && group.matcher ? { matcher: group.matcher } : {}),
          hooks,
        });
    }
    if (parsed.length) config[event as HookEvent] = parsed;
  }
  return { config, problems };
}

export function mergeHooks(...configs: HookConfig[]): HookConfig {
  const out: HookConfig = {};
  for (const c of configs)
    for (const [event, groups] of Object.entries(c) as [HookEvent, HookGroup[]][])
      out[event] = [...(out[event] ?? []), ...groups];
  return out;
}

export function countHooks(config: HookConfig): number {
  return Object.values(config).reduce((n, groups) => n + groups.reduce((m, g) => m + g.hooks.length, 0), 0);
}

// "Edit|Write" and "mcp__.*" are regexes over the whole name; "" and "*" match everything.
function matcherRegex(matcher: string): RegExp | undefined {
  if (matcher === "*") return /^[\s\S]*$/;
  try {
    return new RegExp(`^(?:${matcher})$`);
  } catch {
    return undefined;
  }
}

function matches(group: HookGroup, value: string | undefined): boolean {
  if (!group.matcher || value === undefined) return true;
  return matcherRegex(group.matcher)?.test(value) ?? false;
}

// What every hook receives, plus the event's own fields.
export type HookBase = { session_id: string; transcript_path: string; cwd: string };

export type HookInput =
  | { hook_event_name: "PreToolUse"; tool_name: string; tool_input: unknown }
  | { hook_event_name: "PostToolUse"; tool_name: string; tool_input: unknown; tool_response: unknown }
  | { hook_event_name: "UserPromptSubmit"; prompt: string }
  | { hook_event_name: "Stop"; stop_hook_active: boolean }
  | { hook_event_name: "SessionStart"; source: "startup" | "resume" | "clear" | "compact" }
  | { hook_event_name: "SessionEnd"; reason: "clear" | "logout" | "prompt_input_exit" | "other" }
  | { hook_event_name: "Notification"; message: string }
  | { hook_event_name: "PreCompact"; trigger: "manual" | "auto"; custom_instructions: string };

// The combined answer of every hook that ran for one event.
export type HookOutcome = {
  // Exit code 2 or decision "block": the tool call, prompt or stop is refused; reason says why.
  block?: string;
  // PreToolUse permission answer, strongest wins: deny > ask > allow.
  permission?: { decision: "allow" | "deny" | "ask"; reason: string };
  updatedInput?: unknown;
  // Text for the model (additionalContext, or plain stdout of UserPromptSubmit/SessionStart).
  context: string[];
  // Text for the person: systemMessage, stderr of failed hooks.
  messages: string[];
  // "continue": false — stop the agent altogether, with this reason for the person.
  halt?: string;
  ran: number;
};

export type HookRunnerOptions = {
  config: HookConfig;
  cwd: string;
  projectRoot: string;
  sessionId: string;
  transcriptPath: string;
  env?: Record<string, string | undefined>;
  signal?: AbortSignal;
};

export class HookRunner {
  constructor(private readonly opts: HookRunnerOptions) {}

  has(event: HookEvent): boolean {
    return (this.opts.config[event]?.length ?? 0) > 0;
  }

  // Runs every hook whose matcher fits, in parallel; identical commands run once.
  async run(input: HookInput, matchValue?: string): Promise<HookOutcome> {
    const event = input.hook_event_name;
    const outcome: HookOutcome = { context: [], messages: [], ran: 0 };
    const groups = (this.opts.config[event] ?? []).filter((g) => matches(g, matchValue));
    const unique = new Map<string, HookCommand>();
    for (const g of groups) for (const h of g.hooks) if (!unique.has(h.command)) unique.set(h.command, h);
    if (!unique.size) return outcome;
    const payload: HookBase & HookInput = {
      session_id: this.opts.sessionId,
      transcript_path: this.opts.transcriptPath,
      cwd: this.opts.cwd,
      ...input,
    };
    const results = await Promise.all([...unique.values()].map((h) => this.exec(h, JSON.stringify(payload))));
    for (const r of results) apply(outcome, event, r);
    outcome.ran = results.length;
    return outcome;
  }

  private async exec(hook: HookCommand, stdin: string): Promise<ExecResult> {
    const timeoutMs = (hook.timeoutSec ?? DEFAULT_TIMEOUT_SEC) * 1000;
    const env = {
      ...this.opts.env,
      TEH_PROJECT_DIR: this.opts.projectRoot,
      // Claude Code's name, so existing scripts find the project (ADR-0010).
      CLAUDE_PROJECT_DIR: this.opts.projectRoot,
    };
    let p: ReturnType<typeof Bun.spawn>;
    try {
      p = Bun.spawn(shellArgv(hook.command), {
        cwd: this.opts.cwd,
        env: env as Record<string, string>,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
      });
    } catch (e) {
      return { hook, code: -1, stdout: "", stderr: `could not start: ${(e as Error).message}`, timedOut: false };
    }
    // On timeout, stop waiting at once: a child of the shell can keep the pipes open after the
    // shell itself is killed (seen on Windows).
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((done) => {
      timer = setTimeout(() => done("timeout"), timeoutMs);
    });
    const onAbort = () => p.kill();
    this.opts.signal?.addEventListener("abort", onAbort);
    try {
      const sink = p.stdin as import("bun").FileSink;
      try {
        sink.write(stdin);
        await sink.end();
      } catch {
        // The hook may exit without reading its input.
      }
      const done = Promise.all([
        new Response(p.stdout as ReadableStream).text(),
        new Response(p.stderr as ReadableStream).text(),
        p.exited,
      ]);
      const r = await Promise.race([done, timeout]);
      if (r === "timeout") {
        p.kill();
        return { hook, code: -1, stdout: "", stderr: "", timedOut: true };
      }
      const [stdout, stderr, code] = r;
      return { hook, code, stdout, stderr, timedOut: false };
    } finally {
      clearTimeout(timer);
      this.opts.signal?.removeEventListener("abort", onAbort);
    }
  }
}

type ExecResult = { hook: HookCommand; code: number; stdout: string; stderr: string; timedOut: boolean };

type HookJson = {
  continue?: boolean;
  stopReason?: string;
  systemMessage?: string;
  decision?: string;
  reason?: string;
  hookSpecificOutput?: {
    permissionDecision?: string;
    permissionDecisionReason?: string;
    updatedInput?: unknown;
    additionalContext?: string;
  };
};

function parseJson(stdout: string): HookJson | undefined {
  const t = stdout.trim();
  if (!t.startsWith("{")) return undefined;
  try {
    const v = JSON.parse(t);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as HookJson) : undefined;
  } catch {
    return undefined;
  }
}

const RANK = { allow: 0, ask: 1, deny: 2 } as const;

function setPermission(o: HookOutcome, decision: "allow" | "deny" | "ask", reason: string) {
  if (!o.permission || RANK[decision] > RANK[o.permission.decision]) o.permission = { decision, reason };
}

function addBlock(o: HookOutcome, reason: string) {
  o.block = o.block ? `${o.block}\n${reason}` : reason;
}

// Events whose plain stdout (exit 0) is added to the model's context, as in Claude Code.
const STDOUT_IS_CONTEXT = new Set<HookEvent>(["UserPromptSubmit", "SessionStart"]);
// Events a hook can block.
const BLOCKABLE = new Set<HookEvent>(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);

function apply(o: HookOutcome, event: HookEvent, r: ExecResult) {
  const name = r.hook.command.length > 60 ? `${r.hook.command.slice(0, 59)}…` : r.hook.command;
  if (r.timedOut) {
    o.messages.push(`${event} hook timed out: ${name}`);
    return;
  }
  const stderr = r.stderr.trim();
  if (r.code === 2) {
    const reason = stderr || `blocked by ${event} hook: ${name}`;
    if (BLOCKABLE.has(event)) addBlock(o, reason);
    else o.messages.push(reason);
    if (event === "PreToolUse") setPermission(o, "deny", reason);
    return;
  }
  if (r.code !== 0) {
    o.messages.push(`${event} hook failed (exit ${r.code}): ${name}${stderr ? `\n${stderr}` : ""}`);
    return;
  }
  const json = parseJson(r.stdout);
  if (!json) {
    const out = r.stdout.trim();
    if (out && STDOUT_IS_CONTEXT.has(event)) o.context.push(out);
    return;
  }
  if (json.systemMessage) o.messages.push(json.systemMessage);
  if (json.continue === false) o.halt = json.stopReason || `stopped by ${event} hook`;
  const specific = json.hookSpecificOutput ?? {};
  if (specific.additionalContext) o.context.push(specific.additionalContext);
  if (event === "PreToolUse") {
    // Current field names first, then the older top-level "approve"/"block".
    const d =
      specific.permissionDecision ??
      (json.decision === "approve" ? "allow" : json.decision === "block" ? "deny" : undefined);
    if (d === "allow" || d === "deny" || d === "ask")
      setPermission(o, d, specific.permissionDecisionReason ?? json.reason ?? `${event} hook`);
    if (d === "deny") addBlock(o, specific.permissionDecisionReason ?? json.reason ?? `blocked by ${event} hook`);
    if (specific.updatedInput && typeof specific.updatedInput === "object") o.updatedInput = specific.updatedInput;
  } else if (json.decision === "block" && BLOCKABLE.has(event)) {
    addBlock(o, json.reason || `blocked by ${event} hook: ${name}`);
  }
}
