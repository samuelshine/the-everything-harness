// The agent loop: send the conversation, stream the reply, run requested tools under
// the permission engine, feed results back, and repeat until the model stops.
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { HookEvent, HookOutcome, HookRunner } from "./hooks";
import { findProjectRoot, loadInstructions, renderInstructions } from "./instructions";
import { type Decision, decide, type PermissionConfig, parseRules, type Rule } from "./permissions";
import { systemPrompt } from "./prompt";
import type { Provider } from "./providers/provider";
import { type RouteResult, routerHint } from "./router";
import type { Sandbox } from "./sandbox";
import type { SessionLog } from "./session";
import { type Skill, skillListing } from "./skills";
import type { OutputStyle } from "./styles";
import { skillTool } from "./tools/skill";
import { EXPLORE_BRIEF, EXPLORE_TOOLS, type ExploreRequest, taskTool } from "./tools/task";
import type { Access, Tool, ToolContext, ToolResult } from "./tools/tool";
import { ToolInputError } from "./tools/tool";
import { addUsage, emptyUsage, type Item, ProviderError, type StopReason, type Usage } from "./types";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; summary?: string }
  | {
      type: "approval";
      id: string;
      name: string;
      summary: string;
      behavior: "allow" | "deny";
      reason: string;
      // A rule that would allow this action next time, when it was denied.
      suggestion?: string;
    }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "checkpoint"; sha: string; title: string }
  | { type: "warning"; message: string }
  // Something a hook wants the person to see: systemMessage, a failure, a blocked prompt.
  | { type: "hook"; event: HookEvent; message: string }
  | { type: "turn_end"; usage: Usage }
  // An explore subagent's progress (ADR-0019): `id` is the Task call it runs for.
  | { type: "subagent"; id: string; model: string; phase: "tool"; summary: string }
  | { type: "subagent"; id: string; model: string; phase: "done"; usage: Usage; toolUses: number };

// Asked when the permission engine says "ask". Headless runs answer "deny".
export type Asker = (req: { tool: string; access: Access; reason: string }) => Promise<boolean>;

export type AgentOptions = {
  provider: Provider;
  model: string;
  prompt: string;
  cwd: string;
  tools: Tool[];
  permissions: PermissionConfig;
  ask: Asker;
  addDirs?: string[];
  session?: SessionLog;
  maxTurns?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  userInstructionsFile?: string;
  // Set when the prompt came from "/name args"; logged with the expanded prompt.
  slash?: { name: string; args: string };
  // The skill router's result for this prompt (ADR-0015); its hint follows the prompt.
  skillRoute?: RouteResult;
  // Skills the model may load with the Skill tool (ADR-0015), and the listing budget.
  skills?: Skill[];
  skillListingChars?: number;
  // Notes from connected MCP servers for the system prompt (ADR-0017); their tools go in `tools`.
  mcpInstructions?: { server: string; text: string }[];
  // Output style for the session (ADR-0015); undefined is the default style.
  outputStyle?: OutputStyle;
  // OS sandbox for shell commands (ADR-0003); undefined runs them unsandboxed.
  sandbox?: Sandbox;
  // Earlier conversation when resuming a session (ADR-0004); the prompt is appended to it.
  history?: Item[];
  // Called before the first change of each model turn that changes anything (ADR-0004),
  // so every step can be rewound. `first` marks the run's first. Returns the checkpoint id.
  checkpoint?: (step: { first: boolean; title: string }) => Promise<string>;
  // Lifecycle hooks (ADR-0016). With `hookSessionStart`, SessionStart fires first with that source.
  hooks?: HookRunner;
  hookSessionStart?: "startup" | "resume" | "clear" | "compact";
  // The model for explore subagents (ADR-0019). When set, the Task tool is offered.
  explore?: { provider: Provider; model: string; label: string };
};

export type AgentResult = {
  result: string;
  // hook_blocked: a UserPromptSubmit hook refused the prompt. hook_stopped: a hook said "continue": false.
  stopReason: StopReason | "max_turns" | "hook_blocked" | "hook_stopped";
  turns: number;
  usage: Usage;
  items: Item[];
};

export async function runAgent(opts: AgentOptions): Promise<AgentResult> {
  const emit = opts.onEvent ?? (() => {});
  const projectRoot = findProjectRoot(opts.cwd);
  const instructions = loadInstructions(
    opts.cwd,
    opts.userInstructionsFile ? { userFile: opts.userInstructionsFile } : {},
  );
  const usableSkills = (opts.skills ?? []).filter((s) => s.modelInvocable);
  const listing = skillListing(usableSkills, opts.skillListingChars ?? 4000);
  const loadedSkills = new Set(opts.slash ? [opts.slash.name] : []);
  // Subagent tokens are counted with the run's, though they never enter its context.
  let subagentUsage = emptyUsage();
  let taskCall = "";
  const explore = opts.explore;
  const extra = [
    ...(usableSkills.length ? [skillTool(usableSkills, loadedSkills)] : []),
    ...(explore
      ? [
          taskTool((req) =>
            runExplore(opts, explore, req, taskCall, emit, (u) => {
              subagentUsage = addUsage(subagentUsage, u);
            }),
          ),
        ]
      : []),
  ];
  const tools = [...opts.tools, ...extra];
  const system = systemPrompt({
    cwd: opts.cwd,
    projectRoot,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: existsSync(join(projectRoot, ".git")),
    instructions: renderInstructions(instructions, opts.cwd),
    ...(listing.text ? { skills: listing.text, skillsOmitted: listing.omitted } : {}),
    ...(opts.outputStyle ? { style: opts.outputStyle } : {}),
    ...(opts.mcpInstructions?.length ? { mcpInstructions: opts.mcpInstructions } : {}),
  });
  const ctx: ToolContext = {
    cwd: opts.cwd,
    workspaceRoots: [projectRoot, opts.cwd, ...(opts.addDirs ?? [])],
    readState: new Map(),
    readRoots: usableSkills.map((s) => s.dir),
    ...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const byName = new Map(tools.map((t) => [t.spec.name, t]));
  const log = opts.session;
  // A loaded skill's allowed-tools act as extra allow rules for the rest of the run (ADR-0003).
  // The CLI strips them from project skills in folders the user has not trusted.
  const permissions = (): PermissionConfig => {
    const grants: Rule[] = (opts.skills ?? [])
      .filter((s) => loadedSkills.has(s.name) && s.allowedTools?.length)
      .flatMap((s) => parseRules(s.allowedTools ?? [], `skill ${s.name}`));
    return { projectRoot, ...opts.permissions, allow: [...opts.permissions.allow, ...grants] };
  };
  // Per turn: the conversation before the turn, the checkpoint taken (if any) and what changed.
  const step = { conversationAt: null as string | null, tried: false, sha: "", changes: [] as string[] };
  let firstCheckpoint = true;
  let checkpointsBroken = false;
  const beforeChange = async (summary: string) => {
    if (step.tried || !opts.checkpoint || checkpointsBroken) return;
    step.tried = true;
    try {
      const sha = await opts.checkpoint({ first: firstCheckpoint, title: summary });
      firstCheckpoint = false;
      step.sha = sha;
      log?.append("checkpoint", { sha, kind: "step", title: summary, conversationAt: step.conversationAt });
      emit({ type: "checkpoint", sha, title: summary });
    } catch (e) {
      checkpointsBroken = true;
      const message = `no checkpoint taken, so this run's file changes cannot be rewound: ${(e as Error).message}`;
      log?.append("error", { message });
      emit({ type: "warning", message });
    }
  };

  log?.append("session_start", {
    cwd: opts.cwd,
    projectRoot,
    provider: opts.provider.id,
    model: opts.model,
    permissionMode: opts.permissions.mode,
    ...(opts.outputStyle && opts.outputStyle.name !== "default" ? { outputStyle: opts.outputStyle.name } : {}),
    instructionFiles: instructions.map((f) => f.path),
    resumed: (opts.history?.length ?? 0) > 0,
  });

  const items: Item[] = [...(opts.history ?? [])];
  let usage = emptyUsage();
  let result = "";
  const maxTurns = opts.maxTurns ?? 50;
  const finish = (stopReason: AgentResult["stopReason"], turns: number): AgentResult => {
    const total = addUsage(usage, subagentUsage);
    log?.append("session_end", { stopReason, turns, usage: total });
    return { result, stopReason, turns, usage: total, items };
  };

  const hooks = opts.hooks;
  const report = (event: HookEvent, o: HookOutcome) => reportHook(event, o, emit, log);
  // Text a hook gives the model goes in as its own message, logged so a resumed session keeps it.
  const addHookText = (event: HookEvent, text: string) => {
    const item: Item = { kind: "text", role: "user", text: `${event} hook: ${text}` };
    items.push(item);
    log?.append("hook", { event, text: item.text });
  };
  if (hooks && opts.hookSessionStart) {
    const o = await hooks.run(
      { hook_event_name: "SessionStart", source: opts.hookSessionStart },
      opts.hookSessionStart,
    );
    report("SessionStart", o);
    for (const c of o.context) addHookText("SessionStart", c);
    if (o.halt) return finish("hook_stopped", 0);
  }
  let promptContext: string[] = [];
  if (hooks?.has("UserPromptSubmit")) {
    const o = await hooks.run({ hook_event_name: "UserPromptSubmit", prompt: opts.prompt });
    report("UserPromptSubmit", o);
    if (o.halt) return finish("hook_stopped", 0);
    if (o.block) {
      emit({ type: "hook", event: "UserPromptSubmit", message: `prompt blocked: ${o.block}` });
      return finish("hook_blocked", 0);
    }
    promptContext = o.context;
  }

  items.push({ kind: "text", role: "user", text: opts.prompt });
  log?.append("user_message", { text: opts.prompt, ...(opts.slash ? { slash: opts.slash } : {}) });
  for (const c of promptContext) addHookText("UserPromptSubmit", c);
  if (opts.skillRoute) {
    const hint = routerHint(opts.skillRoute);
    // Sent as its own message so the system prompt (and its cache) stays the same per prompt.
    if (hint) items.push({ kind: "text", role: "user", text: hint });
    log?.append("skill_route", { ...opts.skillRoute, ...(hint ? { hint } : {}) });
  }
  let stopHookActive = false;

  for (let turn = 1; turn <= maxTurns; turn++) {
    let text = "";
    let reasoning = "";
    const calls: { id: string; name: string; args: unknown }[] = [];
    let stop: StopReason = "end";
    let turnUsage = emptyUsage();
    Object.assign(step, { conversationAt: log?.lastEventId ?? null, tried: false, sha: "", changes: [] });

    for await (const ev of opts.provider.stream(
      { model: opts.model, system, items, tools: tools.map((t) => t.spec) },
      opts.signal,
    )) {
      if (ev.type === "text_delta") {
        text += ev.text;
        emit(ev);
      } else if (ev.type === "reasoning_delta") {
        reasoning += ev.text;
        emit(ev);
      } else if (ev.type === "tool_call") calls.push(ev);
      else if (ev.type === "usage") turnUsage = addUsage(turnUsage, ev.usage);
      else stop = ev.reason;
    }

    const produced: Item[] = [];
    if (reasoning) produced.push({ kind: "reasoning", provider: opts.provider.id, text: reasoning });
    if (text) produced.push({ kind: "text", role: "assistant", text });
    for (const c of calls) produced.push({ kind: "tool_call", id: c.id, name: c.name, args: c.args });
    for (const item of produced) {
      items.push(item);
      log?.append("assistant_item", item);
    }
    usage = addUsage(usage, turnUsage);
    log?.append("usage", { turn, ...turnUsage });
    emit({ type: "turn_end", usage: turnUsage });
    if (text) result = text;

    if (calls.length === 0) {
      // A Stop hook can send the model back to work, e.g. until the tests pass.
      if (hooks?.has("Stop") && stop !== "error") {
        const o = await hooks.run({ hook_event_name: "Stop", stop_hook_active: stopHookActive });
        report("Stop", o);
        if (o.halt) return finish("hook_stopped", turn);
        if (o.block) {
          stopHookActive = true;
          addHookText("Stop", o.block);
          continue;
        }
      }
      return finish(stop, turn);
    }

    let halted: string | undefined;
    for (const call of calls) {
      // After a hook stops the run, the remaining calls still get a result, so the
      // conversation stays valid if it is resumed.
      taskCall = call.id;
      const r = halted
        ? { content: `Not run: ${halted}`, isError: true }
        : await runTool(call, byName, opts, permissions(), ctx, emit, beforeChange, report);
      const { changed, halt, ...outcome } = r as Awaited<ReturnType<typeof runTool>>;
      if (changed) step.changes.push(changed);
      if (halt) halted = halt;
      const item: Item = { kind: "tool_result", callId: call.id, name: call.name, ...outcome };
      items.push(item);
      log?.append("tool_result", item);
    }
    // The step's title names everything it changed, once that is known.
    if (step.sha && step.changes.length > 1)
      log?.append("checkpoint_title", { sha: step.sha, title: stepTitle(step.changes) });
    if (halted) return finish("hook_stopped", turn);
  }

  return finish("max_turns", maxTurns);
}

// One explore subagent run: a fresh conversation on the explore model, read-only tools,
// plan mode, and nobody to ask. Its report, with a one-line footer, is the Task result.
async function runExplore(
  parent: AgentOptions,
  explore: NonNullable<AgentOptions["explore"]>,
  req: ExploreRequest,
  callId: string,
  emit: (e: AgentEvent) => void,
  addUsage: (u: Usage) => void,
): Promise<ToolResult> {
  let toolUses = 0;
  const started = performance.now();
  const res = await runAgent({
    provider: explore.provider,
    model: explore.model,
    prompt: `${EXPLORE_BRIEF}\n\nTask: ${req.prompt}`,
    cwd: parent.cwd,
    tools: parent.tools.filter((t) => EXPLORE_TOOLS.includes(t.spec.name)),
    permissions: { ...parent.permissions, mode: "plan" },
    ask: async () => false,
    ...(parent.addDirs ? { addDirs: parent.addDirs } : {}),
    ...(parent.sandbox ? { sandbox: parent.sandbox } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    ...(parent.userInstructionsFile ? { userInstructionsFile: parent.userInstructionsFile } : {}),
    maxTurns: 25,
    onEvent: (e) => {
      if (e.type === "tool_call") {
        toolUses++;
        emit({ type: "subagent", id: callId, model: explore.label, phase: "tool", summary: e.summary ?? e.name });
      }
    },
  });
  addUsage(res.usage);
  emit({ type: "subagent", id: callId, model: explore.label, phase: "done", usage: res.usage, toolUses });
  const tokens = res.usage.input + res.usage.output;
  const secs = Math.round((performance.now() - started) / 1000);
  const report = res.result.trim() || "(the subagent finished without a report)";
  const cut = report.length > 12_000 ? `${report.slice(0, 12_000)}\n… [report truncated]` : report;
  const stopped = res.stopReason === "max_turns" ? " · stopped at the turn limit" : "";
  return {
    content: `${cut}\n\n[explore: ${toolUses} tool use${toolUses === 1 ? "" : "s"} · ${tokens} tokens · ${secs}s · ${explore.label}${stopped}]`,
  };
}

function reportHook(event: HookEvent, o: HookOutcome, emit: (e: AgentEvent) => void, log: SessionLog | undefined) {
  for (const message of o.messages) emit({ type: "hook", event, message });
  if (o.halt) emit({ type: "hook", event, message: `stopped: ${o.halt}` });
  if (!o.ran) return;
  log?.append("hook", {
    event,
    ran: o.ran,
    ...(o.block ? { block: o.block } : {}),
    ...(o.permission ? { permission: o.permission } : {}),
    ...(o.halt ? { halt: o.halt } : {}),
    ...(o.messages.length ? { messages: o.messages } : {}),
  });
}

// The model's raw arguments as an object, for hook input.
function rawArgs(args: unknown): unknown {
  if (typeof args !== "string") return args;
  try {
    return JSON.parse(args);
  } catch {
    return args;
  }
}

async function runTool(
  call: { id: string; name: string; args: unknown },
  byName: Map<string, Tool>,
  opts: AgentOptions,
  permissions: PermissionConfig,
  ctx: ToolContext,
  emit: (e: AgentEvent) => void,
  beforeChange: (summary: string) => Promise<void>,
  report: (event: HookEvent, o: HookOutcome) => void,
): Promise<{ content: string; isError: boolean; changed?: string; halt?: string }> {
  const log = opts.session;
  const fail = (content: string) => {
    emit({ type: "tool_result", id: call.id, name: call.name, content, isError: true });
    return { content, isError: true };
  };

  const tool = byName.get(call.name);
  if (!tool) {
    emit({ type: "tool_call", ...call });
    return fail(`unknown tool "${call.name}"; available: ${[...byName.keys()].join(", ")}`);
  }

  let args: unknown;
  let access: Access;
  let input = rawArgs(call.args);
  let pre: HookOutcome | undefined;
  try {
    args = tool.parse(call.args);
    // PreToolUse hooks see the call before the permission check and may replace its input.
    if (opts.hooks?.has("PreToolUse")) {
      pre = await opts.hooks.run({ hook_event_name: "PreToolUse", tool_name: call.name, tool_input: input }, call.name);
      report("PreToolUse", pre);
      if (pre.updatedInput !== undefined && !pre.block) {
        input = pre.updatedInput;
        args = tool.parse(input);
      }
    }
    access = tool.access(args, ctx);
  } catch (e) {
    emit({ type: "tool_call", ...call });
    if (e instanceof ToolInputError) return fail(`invalid arguments for ${call.name}: ${e.message}`);
    throw e;
  }
  emit({ type: "tool_call", ...call, summary: access.summary });
  log?.append("tool_call", {
    id: call.id,
    name: call.name,
    args: call.args,
    summary: access.summary,
    ...(input !== rawArgs(call.args) ? { hookInput: input } : {}),
  });
  if (pre?.halt) return { ...fail(`Not run: ${pre.halt}`), halt: pre.halt };

  const decision = hookDecision(decide(call.name, access, permissions, ctx), pre?.permission);
  let behavior: "allow" | "deny" = decision.behavior === "ask" ? "deny" : decision.behavior;
  let reason = decision.reason;
  if (decision.behavior === "ask") {
    const approved = await opts.ask({ tool: call.name, access, reason: decision.reason });
    behavior = approved ? "allow" : "deny";
    reason = approved ? `approved by user (${decision.reason})` : `${decision.reason} needs approval`;
  }
  // Every decision is logged; auto-allowed reads are frequent, so only non-read decisions are emitted.
  const suggestion = behavior === "deny" && decision.behavior === "ask" ? decision.suggestion : undefined;
  log?.append("approval", {
    id: call.id,
    tool: call.name,
    summary: access.summary,
    behavior,
    reason,
    ...(suggestion ? { suggestion } : {}),
  });
  if (access.kind !== "read" || behavior === "deny") {
    emit({
      type: "approval",
      id: call.id,
      name: call.name,
      summary: access.summary,
      behavior,
      reason,
      ...(suggestion ? { suggestion } : {}),
    });
  }
  if (behavior === "deny") {
    if (decision.byHook)
      return fail(`Blocked by a PreToolUse hook: ${pre?.block ?? reason}. Do not retry the same action.`);
    return fail(
      `Permission denied: ${access.summary} (${reason}). Do not retry the same action; continue without it or tell the user what you need.`,
    );
  }

  // Reads and read-only commands change nothing, so they need no checkpoint.
  // MCP tools act outside the project as far as teh knows, so they get no checkpoint either.
  const changes = (access.kind === "write" || access.kind === "execute") && !decision.readOnly;
  if (changes) await beforeChange(access.summary);
  let out: ToolResult;
  try {
    out = await tool.run(args, { ...ctx, sandboxLevel: decision.readOnly ? "read-only" : "workspace-write" });
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    out = { content: `${call.name} failed: ${(e as Error).message}`, isError: true };
  }
  let isError = out.isError ?? false;
  let content = out.content;
  let halt: string | undefined;
  if (opts.hooks?.has("PostToolUse")) {
    const post = await opts.hooks.run(
      {
        hook_event_name: "PostToolUse",
        tool_name: call.name,
        tool_input: input,
        tool_response: { content: out.content, is_error: isError },
      },
      call.name,
    );
    report("PostToolUse", post);
    // The tool already ran; a "block" from PostToolUse is feedback the model must act on.
    if (post.block) {
      content += `\n\nPostToolUse hook feedback:\n${post.block}`;
      isError = true;
    }
    for (const c of post.context) content += `\n\nPostToolUse hook: ${c}`;
    halt = post.halt;
  }
  emit({ type: "tool_result", id: call.id, name: call.name, content, isError });
  return { content, isError, ...(changes ? { changed: access.summary } : {}), ...(halt ? { halt } : {}) };
}

// Combine the permission engine's decision with a PreToolUse hook's (ADR-0016). A hook can
// deny anything, and can turn an allow into an ask. It can turn an ask into an allow, but it
// never overrides a deny rule or plan mode.
function hookDecision(
  d: Decision,
  hook: { decision: "allow" | "deny" | "ask"; reason: string } | undefined,
): Decision & { byHook?: boolean } {
  if (!hook) return d;
  if (hook.decision === "deny") return { behavior: "deny", reason: `PreToolUse hook: ${hook.reason}`, byHook: true };
  if (d.behavior === "deny") return d;
  if (hook.decision === "ask" && d.behavior === "allow")
    return { behavior: "ask", reason: `PreToolUse hook asks first: ${hook.reason}` };
  if (hook.decision === "allow" && d.behavior === "ask")
    return { behavior: "allow", reason: `allowed by PreToolUse hook: ${hook.reason}` };
  return d;
}

// "Edit a.ts, Create b.ts and 2 more"
export function stepTitle(changes: string[]): string {
  const unique = [...new Set(changes)];
  if (unique.length <= 3) return unique.join(", ");
  return `${unique.slice(0, 2).join(", ")} and ${unique.length - 2} more`;
}
