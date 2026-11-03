// Append-only JSONL session log (ADR-0004). One event per line; `parent` links make
// the log a tree so rewind and fork never rewrite history. File checkpoints: checkpoints.ts.
import { createHash } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";

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

export class SessionLog {
  readonly id = Bun.randomUUIDv7();
  readonly path: string;
  private last: string | null = null;

  constructor(
    home: string,
    projectRoot: string,
    readonly owner = `local:${userInfo().username}`,
  ) {
    const dir = join(home, "projects", projectKey(projectRoot), "sessions");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
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
    const first = this.last === null;
    // One write per event, so a crash can only tear the final line.
    appendFileSync(this.path, `${JSON.stringify(event)}\n`, { mode: 0o600 });
    if (first) chmodSync(this.path, 0o600);
    this.last = event.id;
    return event.id;
  }
}
