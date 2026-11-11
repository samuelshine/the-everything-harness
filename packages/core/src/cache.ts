// Per-session cache (ADR-0018): what the interactive UI showed, line by line, so a resumed
// session can redraw its transcript exactly, tool output and diffs included. It is a cache:
// files untouched for `cacheRetentionDays` (default 3) are deleted. The conversation itself
// lives in the session log, so `teh -c` still continues a session whose cache has gone.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { projectKey } from "./session";

export const DEFAULT_CACHE_RETENTION_DAYS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

export function cacheDir(home: string, projectRoot: string): string {
  return join(home, "projects", projectKey(projectRoot), "cache");
}

export class TranscriptCache {
  readonly dir: string;

  constructor(home: string, projectRoot: string) {
    this.dir = cacheDir(home, projectRoot);
  }

  path(sessionId: string): string {
    return join(this.dir, `${sessionId}.transcript.jsonl`);
  }

  // The lines shown for a session, or undefined when there is no cache (never made, or expired).
  load(sessionId: string): string[] | undefined {
    const p = this.path(sessionId);
    if (!existsSync(p)) return undefined;
    const lines: string[] = [];
    for (const row of readFileSync(p, "utf8").split("\n")) {
      if (!row) continue;
      try {
        const batch = JSON.parse(row);
        if (Array.isArray(batch)) lines.push(...batch.map(String));
      } catch {
        // A torn last line after a crash; keep the rest.
      }
    }
    return lines;
  }

  append(sessionId: string, lines: string[]): void {
    if (!lines.length) return;
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    appendFileSync(this.path(sessionId), `${JSON.stringify(lines)}\n`, { mode: 0o600 });
  }
}

// Delete cache files across all projects that have not been written for `days` days.
// Returns the paths removed. Session logs and checkpoints are not touched.
export function pruneCaches(home: string, days: number, now = Date.now()): string[] {
  const removed: string[] = [];
  const projects = join(home, "projects");
  if (!existsSync(projects)) return removed;
  const cutoff = now - days * DAY_MS;
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project, "cache");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) {
          rmSync(p, { recursive: true, force: true });
          removed.push(p);
        }
      } catch {
        // Gone already, or not ours to remove.
      }
    }
  }
  return removed;
}

export const DEFAULT_CLEANUP_PERIOD_DAYS = 30;

// Delete sessions across all projects that nobody has written to for `days` days (ADR-0004),
// with their UI caches. Returns the session files removed.
export function pruneSessions(home: string, days: number, now = Date.now()): string[] {
  const removed: string[] = [];
  const projects = join(home, "projects");
  if (!existsSync(projects)) return removed;
  const cutoff = now - days * DAY_MS;
  for (const project of readdirSync(projects)) {
    const dir = join(projects, project, "sessions");
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".jsonl")) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs >= cutoff) continue;
        rmSync(p, { force: true });
        rmSync(join(projects, project, "cache", name.replace(/\.jsonl$/, ".transcript.jsonl")), { force: true });
        removed.push(p);
      } catch {
        // Gone already.
      }
    }
  }
  return removed;
}
