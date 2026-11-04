// Append-only JSONL session log (ADR-0004). One event per line; `parent` links make
// the log a tree so rewind and fork never rewrite history. File checkpoints: checkpoints.ts.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import type { Item } from "./types";

export const SESSION_SCHEMA_VERSION = 1;

export type SessionEventType =
  | "session_start"
  | "user_message"
  | "assistant_item"
  | "tool_call"
  | "tool_result"
  | "approval"
  | "model_change"
  | "usage"
  | "checkpoint"
  | "checkpoint_title"
  | "rewind"
  | "skill_route"
  | "error"
  | "session_end";

export type SessionEvent = {
  v: number;
  id: string;
  parent: string | null;
  ts: string;
  session: string;
  owner: string;
  type: SessionEventType;
  data: unknown;
};

export function tehHome(env: Record<string, string | undefined> = process.env): string {
  return env.TEH_HOME || join(homedir(), ".teh");
}

// Readable prefix plus a hash, so two paths that sanitise the same never collide.
export function projectKey(root: string): string {
  const readable = root
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(-60);
  return `${readable}-${createHash("sha256").update(root).digest("hex").slice(0, 8)}`;
}

export function sessionsDir(home: string, projectRoot: string): string {
  return join(home, "projects", projectKey(projectRoot), "sessions");
}

export class SessionLog {
  readonly id: string;
  readonly path: string;
  private last: string | null;

  get lastEventId(): string | null {
    return this.last;
  }

  // Pass `resume` to keep appending to an existing session after its last event.
  constructor(
    home: string,
    projectRoot: string,
    readonly owner = `local:${userInfo().username}`,
    resume?: LoadedSession,
  ) {
    const dir = sessionsDir(home, projectRoot);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    this.id = resume?.id ?? Bun.randomUUIDv7();
    this.last = resume?.lastEventId ?? null;
    this.path = join(dir, `${this.id}.jsonl`);
  }

  append(type: SessionEventType, data: unknown): string {
    const event: SessionEvent = {
      v: SESSION_SCHEMA_VERSION,
      id: Bun.randomUUIDv7(),
      parent: this.last,
      ts: new Date().toISOString(),
      session: this.id,
      owner: this.owner,
      type,
      data,
    };
    const first = !existsSync(this.path);
    // One write per event, so a crash can only tear the final line.
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (first) chmodSync(this.path, 0o600);
    this.last = event.id;
    return event.id;
  }
}

export type SessionSummary = {
  id: string;
  path: string;
  updated: Date;
  // provider:model from the latest session_start
  model?: string;
  firstPrompt: string;
  prompts: number;
};

// A place in the session you can rewind to (ADR-0004). Points are never removed:
// ones a later rewind went back past are marked `rewound`, so you can go forward again.
export type RewindPoint = {
  n: number;
  kind: "prompt" | "step" | "rewind";
  title: string;
  time: Date;
  // Which prompt of the session it belongs to (1-based) and that prompt's text.
  prompt: number;
  promptText: string;
  // Conversation state at this point: the id of the last event it includes (null = empty).
  conversationAt: string | null;
  // Checkpoint holding the files as they were at this point. Undefined when teh changed
  // no files after it, so the files are already as they were.
  sha?: string;
  rewound: boolean;
};

export type LoadedSession = SessionSummary & {
  lastEventId: string | null;
  // The conversation, ready to send again: user messages, assistant items and tool results.
  items: Item[];
  points: RewindPoint[];
  // Output style of the latest run, so resuming keeps it (ADR-0015).
  outputStyle?: string;
};

export type RewindScope = "both" | "conversation" | "code";

// The conversation as an immutable chain, so any event's state can be revisited after a rewind.
type Node = { eventId: string; item?: Item; prev: Node | null };

function materialise(node: Node | null | undefined): Item[] {
  const out: Item[] = [];
  for (let n = node; n; n = n.prev) if (n.item) out.push(n.item);
  return out.reverse();
}

export function readEvents(path: string): SessionEvent[] {
  const lines = readFileSync(path, "utf8").split("\n");
  const events: SessionEvent[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch (e) {
      // Only the final line can be torn by a crash mid-write.
      if (i < lines.length - 2) throw new Error(`${path}: line ${i + 1} is not valid JSON`, { cause: e });
    }
  }
  return events;
}

function replay(events: SessionEvent[]) {
  const states = new Map<string, Node | null>();
  let current: Node | null = null;
  let model: string | undefined;
  let outputStyle: string | undefined;
  let firstPrompt = "";
  let prompts = 0;
  let promptText = "";
  const points: RewindPoint[] = [];
  const add = (p: Omit<RewindPoint, "n" | "rewound" | "prompt" | "promptText">) =>
    points.push({ ...p, n: points.length + 1, rewound: false, prompt: prompts, promptText });

  for (const ev of events) {
    const data = (ev.data ?? {}) as Record<string, unknown>;
    let item: Item | undefined;
    if (ev.type === "session_start") {
      model = `${data.provider}:${data.model}`;
      outputStyle = typeof data.outputStyle === "string" ? data.outputStyle : undefined;
    } else if (ev.type === "user_message") {
      const text = String(data.text ?? "");
      if (!prompts) firstPrompt = text;
      prompts++;
      promptText = text;
      const at = current?.eventId ?? null;
      add({ kind: "prompt", title: `Before prompt ${prompts}`, time: new Date(ev.ts), conversationAt: at });
      item = { kind: "text", role: "user", text };
    } else if (ev.type === "assistant_item" || ev.type === "tool_result") item = ev.data as Item;
    else if (ev.type === "skill_route" && typeof data.hint === "string")
      item = { kind: "text", role: "user", text: data.hint };
    else if (ev.type === "checkpoint" && (typeof data.sha === "string" || data.kind === "rewind")) {
      add({
        kind: data.kind === "rewind" ? "rewind" : "step",
        title: String(data.title ?? "Before a change"),
        time: new Date(ev.ts),
        conversationAt: typeof data.conversationAt === "string" ? data.conversationAt : (current?.eventId ?? null),
        ...(typeof data.sha === "string" ? { sha: data.sha } : {}),
      });
    } else if (ev.type === "checkpoint_title") {
      const p = points.findLast((x) => x.sha === data.sha && x.kind === "step");
      if (p) p.title = String(data.title);
    } else if (ev.type === "rewind" && data.scope !== "code") {
      current = typeof data.to === "string" ? (states.get(data.to) ?? null) : null;
    }
    current = { eventId: ev.id, ...(item ? { item } : {}), prev: current };
    states.set(ev.id, current);
  }

  // A point is rewound when the current conversation no longer passes through it.
  const live = new Set<string>();
  for (let n = current; n; n = n.prev) live.add(n.eventId);
  for (const p of points) p.rewound = p.kind !== "rewind" && p.conversationAt !== null && !live.has(p.conversationAt);

  // Files at a prompt point are the files as they were before the next change after it,
  // whether teh's own step or a restore made by a rewind.
  for (const [i, p] of points.entries()) {
    if (!p.sha) {
      const next = points.slice(i + 1).find((x) => x.sha);
      if (next?.sha) p.sha = next.sha;
    }
  }
  return { states, current, model, outputStyle, firstPrompt, prompts, points };
}

// Replays a session file into its conversation and rewind points.
export function loadSession(path: string): LoadedSession {
  const events = readEvents(path);
  const r = replay(events);
  return {
    id: events[0]?.session ?? "",
    path,
    updated: statSync(path).mtime,
    ...(r.model ? { model: r.model } : {}),
    firstPrompt: r.firstPrompt,
    prompts: r.prompts,
    lastEventId: events.at(-1)?.id ?? null,
    items: closeDanglingCalls(materialise(r.current)),
    points: r.points,
    ...(r.outputStyle ? { outputStyle: r.outputStyle } : {}),
  };
}

// The conversation as it stood at a rewind point.
export function conversationAt(path: string, point: RewindPoint): Item[] {
  if (!point.conversationAt) return [];
  return closeDanglingCalls(materialise(replay(readEvents(path)).states.get(point.conversationAt)));
}

// Providers reject a tool call with no result, which a crash or abort can leave behind.
// Missing results are added at the end of their turn's result block, keeping calls and
// results grouped the way every adapter expects.
function closeDanglingCalls(items: Item[]): Item[] {
  const out: Item[] = [];
  const open = new Map<string, string>(); // call id -> tool name
  let prev: Item["kind"] | undefined;
  const flush = () => {
    for (const [callId, name] of open) {
      out.push({
        kind: "tool_result",
        callId,
        name,
        content: "interrupted: this tool call never finished",
        isError: true,
      });
    }
    open.clear();
  };
  for (const item of items) {
    if (item.kind === "tool_result") open.delete(item.callId);
    else if (!(item.kind === "tool_call" && prev === "tool_call")) flush();
    if (item.kind === "tool_call") open.set(item.id, item.name);
    out.push(item);
    prev = item.kind;
  }
  flush();
  return out;
}

// Sessions for a project, most recently updated first.
export function listSessions(home: string, projectRoot: string): SessionSummary[] {
  const dir = sessionsDir(home, projectRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const { items: _items, lastEventId: _last, points: _points, ...summary } = loadSession(join(dir, f));
      return summary;
    })
    .filter((s) => s.id)
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

export function findSession(home: string, projectRoot: string, ref: string): LoadedSession | undefined {
  const match = listSessions(home, projectRoot).filter((s) => s.id.startsWith(ref));
  return match.length === 1 && match[0] ? loadSession(match[0].path) : undefined;
}
