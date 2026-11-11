import { realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { Sandbox, SandboxLevel } from "../sandbox";
import type { ToolSpec } from "../types";
import type { SearchEngine, WebHelper } from "./web";

export type ToolContext = {
  cwd: string;
  // Directories the agent may write to without extra approval (cwd plus --add-dir).
  workspaceRoots: string[];
  // Files read this session and their mtime when read; Edit/Write require a fresh read.
  readState: Map<string, number>;
  // Directories the agent may read without approval but not change (e.g. skill folders).
  readRoots?: string[];
  signal?: AbortSignal;
  // OS sandbox for shell commands (ADR-0003), and the level for the current call: commands
  // that ran without asking because they are read-only get the stricter one.
  sandbox?: Sandbox;
  sandboxLevel?: SandboxLevel;
  // For WebFetch: a model call that reads a page against the caller's question (ADR-0021).
  webHelper?: WebHelper;
  // For WebSearch: which engine to query.
  webSearch?: SearchEngine;
};

export type ToolResult = { content: string; isError?: boolean };

// What a call would touch, so the permission engine can decide before it runs.
export type Access =
  | { kind: "read"; paths: string[]; summary: string }
  | { kind: "write"; paths: string[]; summary: string }
  | { kind: "execute"; command: string; summary: string }
  // A tool outside teh, such as an MCP server's (ADR-0017). Its effects are unknown.
  | { kind: "external"; server: string; summary: string }
  // A request to another machine (ADR-0021): WebFetch's host, or the search engine's.
  | { kind: "network"; host: string; summary: string };

export interface Tool<A = unknown> {
  spec: ToolSpec;
  // Validate raw model-supplied arguments; throw ToolInputError with a message the model can act on.
  parse(raw: unknown): A;
  access(args: A, ctx: ToolContext): Access;
  run(args: A, ctx: ToolContext): Promise<ToolResult>;
}

export class ToolInputError extends Error {}

export function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new ToolInputError("arguments must be a JSON object");
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ToolInputError("arguments must be a JSON object");
  return raw as Record<string, unknown>;
}

export function str(o: Record<string, unknown>, key: string): string;
export function str(o: Record<string, unknown>, key: string, optional: true): string | undefined;
export function str(o: Record<string, unknown>, key: string, optional = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) {
    if (optional) return undefined;
    throw new ToolInputError(`missing required string "${key}"`);
  }
  if (typeof v !== "string") throw new ToolInputError(`"${key}" must be a string`);
  return v;
}

export function int(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isInteger(n) || n < 0)
    throw new ToolInputError(`"${key}" must be a non-negative integer`);
  return n;
}

export function bool(o: Record<string, unknown>, key: string): boolean {
  const v = o[key];
  return v === true || v === "true";
}

export function resolvePath(p: string, ctx: ToolContext): string {
  return isAbsolute(p) ? resolve(p) : resolve(ctx.cwd, p);
}

// Resolve symlinks for the deepest existing ancestor so `ws/link -> /etc` is seen as /etc.
function canonical(p: string): string {
  let cur = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return resolve(realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = dirname(cur);
      if (parent === cur) return p;
      rest.push(cur.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cur = parent;
    }
  }
}

export function insideWorkspace(p: string, ctx: ToolContext, roots = ctx.workspaceRoots): boolean {
  const target = canonical(p);
  return roots.some((root) => {
    const rel = relative(canonical(root), target);
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

export function display(p: string, ctx: ToolContext): string {
  const rel = relative(ctx.cwd, p);
  if (rel === "") return ".";
  return !rel.startsWith("..") && !isAbsolute(rel) ? rel : p;
}

// Keep the head and tail of long output; the middle is least useful to the model.
export function truncate(text: string, max = 30_000): string {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n\n… [${text.length - max} characters truncated] …\n\n${text.slice(-half)}`;
}
