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

export type LoadedSession = SessionSummary & {
  lastEventId: string | null;
  // The conversation, ready to send again: user messages, assistant items and tool results.
  items: Item[];
};

// Replays a session file. A torn final line (a crash mid-write) is ignored.
export function loadSession(path: string): LoadedSession {
  const lines = readFileSync(path, "utf8").split("\n");
  const events: SessionEvent[] = [];
  for (const [i, line] of lines.entries()) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as SessionEvent);
    } catch (e) {
      if (i < lines.length - 2) throw new Error(`${path}: line ${i + 1} is not valid JSON`, { cause: e });
    }
  }
  const items: Item[] = [];
  let model: string | undefined;
  let firstPrompt = "";
  let prompts = 0;
  for (const ev of events) {
    const data = ev.data as Record<string, unknown>;
    if (ev.type === "session_start") model = `${data.provider}:${data.model}`;
    else if (ev.type === "user_message") {
      const text = String(data.text ?? "");
      if (!prompts) firstPrompt = text;
      prompts++;
      items.push({ kind: "text", role: "user", text });
    } else if (ev.type === "assistant_item" || ev.type === "tool_result") items.push(ev.data as Item);
  }
  return {
    id: events[0]?.session ?? "",
    path,
    updated: statSync(path).mtime,
    ...(model ? { model } : {}),
    firstPrompt,
    prompts,
    lastEventId: events.at(-1)?.id ?? null,
    items: closeDanglingCalls(items),
  };
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
      const { items: _items, lastEventId: _last, ...summary } = loadSession(join(dir, f));
      return summary;
    })
    .filter((s) => s.id)
    .sort((a, b) => b.updated.getTime() - a.updated.getTime());
}

export function findSession(home: string, projectRoot: string, ref: string): LoadedSession | undefined {
  const match = listSessions(home, projectRoot).filter((s) => s.id.startsWith(ref));
  return match.length === 1 && match[0] ? loadSession(match[0].path) : undefined;
}
