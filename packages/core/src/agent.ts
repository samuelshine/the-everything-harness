// The agent loop: send the conversation, stream the reply, run requested tools under
// the permission engine, feed results back, and repeat until the model stops.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot, loadInstructions, renderInstructions } from "./instructions";
import { decide, type PermissionConfig } from "./permissions";
import { systemPrompt } from "./prompt";
import type { Provider } from "./providers/provider";
import type { SessionLog } from "./session";
import type { Access, Tool, ToolContext, ToolResult } from "./tools/tool";
import { ToolInputError } from "./tools/tool";
import { addUsage, emptyUsage, type Item, ProviderError, type StopReason, type Usage } from "./types";

export type AgentEvent =
  | { type: "text_delta"; text: string }
  | { type: "reasoning_delta"; text: string }
  | { type: "tool_call"; id: string; name: string; args: unknown; summary?: string }
  | { type: "approval"; id: string; name: string; summary: string; behavior: "allow" | "deny"; reason: string }
  | { type: "tool_result"; id: string; name: string; content: string; isError: boolean }
  | { type: "checkpoint"; sha: string }
  | { type: "warning"; message: string }
  | { type: "turn_end"; usage: Usage };

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
  // Earlier conversation when resuming a session (ADR-0004); the prompt is appended to it.
  history?: Item[];
  // Called once, before the first change of the run (ADR-0004). Returns the checkpoint id.
  checkpoint?: () => Promise<string>;
};

export type AgentResult = {
  result: string;
  stopReason: StopReason | "max_turns";
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
  const system = systemPrompt({
    cwd: opts.cwd,
    projectRoot,
    platform: process.platform,
    date: new Date().toISOString().slice(0, 10),
    isGitRepo: existsSync(join(projectRoot, ".git")),
    instructions: renderInstructions(instructions, opts.cwd),
  });
  const ctx: ToolContext = {
    cwd: opts.cwd,
    workspaceRoots: [projectRoot, opts.cwd, ...(opts.addDirs ?? [])],
    readState: new Map(),
    ...(opts.signal ? { signal: opts.signal } : {}),
  };
  const byName = new Map(opts.tools.map((t) => [t.spec.name, t]));
  const log = opts.session;
  let checkpointed = false;
  const beforeChange = async () => {
    if (checkpointed || !opts.checkpoint) return;
    checkpointed = true;
    try {
      const sha = await opts.checkpoint();
      log?.append("checkpoint", { sha });
      emit({ type: "checkpoint", sha });
    } catch (e) {
      const message = `no checkpoint taken, so this run's file changes cannot be undone: ${(e as Error).message}`;
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
    instructionFiles: instructions.map((f) => f.path),
    resumed: (opts.history?.length ?? 0) > 0,
  });

  const items: Item[] = [...(opts.history ?? []), { kind: "text", role: "user", text: opts.prompt }];
  log?.append("user_message", { text: opts.prompt });

  let usage = emptyUsage();
  let result = "";
  const maxTurns = opts.maxTurns ?? 50;

  for (let turn = 1; turn <= maxTurns; turn++) {
    let text = "";
    let reasoning = "";
    const calls: { id: string; name: string; args: unknown }[] = [];
    let stop: StopReason = "end";
    let turnUsage = emptyUsage();

    for await (const ev of opts.provider.stream(
      { model: opts.model, system, items, tools: opts.tools.map((t) => t.spec) },
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
      log?.append("session_end", { stopReason: stop, turns: turn, usage });
      return { result, stopReason: stop, turns: turn, usage, items };
    }

    for (const call of calls) {
      const outcome = await runTool(call, byName, opts, ctx, emit, beforeChange);
      const item: Item = { kind: "tool_result", callId: call.id, name: call.name, ...outcome };
      items.push(item);
      log?.append("tool_result", item);
    }
  }

  log?.append("session_end", { stopReason: "max_turns", turns: maxTurns, usage });
  return { result, stopReason: "max_turns", turns: maxTurns, usage, items };
}

async function runTool(
  call: { id: string; name: string; args: unknown },
  byName: Map<string, Tool>,
  opts: AgentOptions,
  ctx: ToolContext,
  emit: (e: AgentEvent) => void,
  beforeChange: () => Promise<void>,
): Promise<{ content: string; isError: boolean }> {
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
  try {
    args = tool.parse(call.args);
    access = tool.access(args, ctx);
  } catch (e) {
    emit({ type: "tool_call", ...call });
    if (e instanceof ToolInputError) return fail(`invalid arguments for ${call.name}: ${e.message}`);
    throw e;
  }
  emit({ type: "tool_call", ...call, summary: access.summary });
  log?.append("tool_call", { id: call.id, name: call.name, args: call.args, summary: access.summary });

  const decision = decide(call.name, access, opts.permissions, ctx);
  let behavior: "allow" | "deny" = decision.behavior === "ask" ? "deny" : decision.behavior;
  let reason = decision.reason;
  if (decision.behavior === "ask") {
    const approved = await opts.ask({ tool: call.name, access, reason: decision.reason });
    behavior = approved ? "allow" : "deny";
    reason = approved ? `approved by user (${decision.reason})` : `${decision.reason} needs approval`;
  }
  // Every decision is logged; auto-allowed reads are frequent, so only non-read decisions are emitted.
  log?.append("approval", { id: call.id, tool: call.name, summary: access.summary, behavior, reason });
  if (access.kind !== "read" || behavior === "deny") {
    emit({ type: "approval", id: call.id, name: call.name, summary: access.summary, behavior, reason });
  }
  if (behavior === "deny") {
    return fail(
      `Permission denied: ${access.summary} (${reason}). Do not retry the same action; continue without it or tell the user what you need.`,
    );
  }

  if (access.kind !== "read") await beforeChange();
  let out: ToolResult;
  try {
    out = await tool.run(args, ctx);
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    out = { content: `${call.name} failed: ${(e as Error).message}`, isError: true };
  }
  const isError = out.isError ?? false;
  emit({ type: "tool_result", id: call.id, name: call.name, content: out.content, isError });
  return { content: out.content, isError };
}
