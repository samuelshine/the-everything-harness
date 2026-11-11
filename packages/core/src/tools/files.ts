// Read, Write and Edit. Edits and overwrites require a fresh Read of the file, so the
// model never changes a file it has not seen or that changed underneath it.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { diffSnippet, plural } from "./diff";
import { bool, display, int, obj, resolvePath, str, type Tool, type ToolContext, ToolInputError } from "./tool";

const MAX_LINES = 2000;
const MAX_LINE_CHARS = 2000;

function mtime(p: string): number {
  return statSync(p).mtimeMs;
}

function requireFreshRead(path: string, ctx: ToolContext): string | undefined {
  const seen = ctx.readState.get(path);
  if (seen === undefined) return `read ${display(path, ctx)} with the Read tool before changing it`;
  if (mtime(path) !== seen) return `${display(path, ctx)} changed since you read it; read it again first`;
  return undefined;
}

type ReadArgs = { path: string; offset: number; limit: number };

export const readTool: Tool<ReadArgs> = {
  spec: {
    name: "Read",
    description: `Read a text file. Returns lines prefixed with their line numbers. Reads up to ${MAX_LINES} lines; use offset (1-based line) and limit for longer files.`,
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file, absolute or relative to the working directory" },
        offset: { type: "integer", description: "1-based line to start from" },
        limit: { type: "integer", description: "Number of lines to read" },
      },
      required: ["file_path"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    return { path: str(o, "file_path"), offset: int(o, "offset") ?? 1, limit: int(o, "limit") ?? MAX_LINES };
  },
  access(a, ctx) {
    const p = resolvePath(a.path, ctx);
    return { kind: "read", paths: [p], summary: `Read ${display(p, ctx)}` };
  },
  async run(a, ctx) {
    const p = resolvePath(a.path, ctx);
    if (!existsSync(p)) return { content: `file not found: ${display(p, ctx)}`, isError: true };
    if (statSync(p).isDirectory()) return { content: `${display(p, ctx)} is a directory; use Glob`, isError: true };
    const buf = readFileSync(p);
    if (buf.subarray(0, 8192).includes(0)) return { content: `${display(p, ctx)} looks binary`, isError: true };
    ctx.readState.set(p, mtime(p));
    const lines = buf.toString("utf8").split("\n");
    const start = Math.max(1, a.offset);
    const slice = lines.slice(start - 1, start - 1 + a.limit);
    if (slice.length === 0) return { content: `(file has ${lines.length} lines; nothing at line ${start})` };
    const body = slice
      .map((l, i) => {
        const line = l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}… [line truncated]` : l;
        return `${String(start + i).padStart(6)}\t${line}`;
      })
      .join("\n");
    const more =
      start - 1 + slice.length < lines.length ? `\n(${lines.length} lines total; use offset to read more)` : "";
    return { content: body + more };
  },
};

type WriteArgs = { path: string; content: string };

export const writeTool: Tool<WriteArgs> = {
  spec: {
    name: "Write",
    description:
      "Create a file or overwrite it completely. Prefer Edit for changes to existing files. Overwriting requires reading the file first.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
        content: { type: "string", description: "Full file content" },
      },
      required: ["file_path", "content"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    return { path: str(o, "file_path"), content: str(o, "content") };
  },
  access(a, ctx) {
    const p = resolvePath(a.path, ctx);
    return {
      kind: "write",
      paths: [p],
      summary: `${existsSync(p) ? "Overwrite" : "Create"} ${display(p, ctx)} (${plural(a.content.split("\n").length, "line")})`,
    };
  },
  async run(a, ctx) {
    const p = resolvePath(a.path, ctx);
    if (existsSync(p)) {
      const stale = requireFreshRead(p, ctx);
      if (stale) return { content: stale, isError: true };
    }
    const before = existsSync(p) ? readFileSync(p, "utf8") : undefined;
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, a.content);
    ctx.readState.set(p, mtime(p));
    const lines = a.content.split("\n").length;
    if (before === undefined) return { content: `created ${display(p, ctx)} (${plural(lines, "line")})` };
    if (before === a.content) return { content: `wrote ${display(p, ctx)}: content unchanged` };
    const d = diffSnippet(before, a.content);
    return {
      content: `overwrote ${display(p, ctx)}: ${plural(d.removed, "line")} removed, ${plural(d.added, "line")} added. Check this is what you meant:\n${d.text}`,
    };
  },
};

type EditArgs = { path: string; oldString: string; newString: string; replaceAll: boolean };

export const editTool: Tool<EditArgs> = {
  spec: {
    name: "Edit",
    description:
      "Replace text in a file. old_string must match the file exactly (including indentation) and be unique unless replace_all is true. Read the file first.",
    inputSchema: {
      type: "object",
      properties: {
        file_path: { type: "string", description: "Path to the file" },
        old_string: { type: "string", description: "Exact text to replace" },
        new_string: { type: "string", description: "Replacement text" },
        replace_all: { type: "boolean", description: "Replace every occurrence" },
      },
      required: ["file_path", "old_string", "new_string"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    const a = {
      path: str(o, "file_path"),
      oldString: str(o, "old_string"),
      newString: str(o, "new_string"),
      replaceAll: bool(o, "replace_all"),
    };
    if (a.oldString === "") throw new ToolInputError("old_string must not be empty; use Write to create files");
    if (a.oldString === a.newString) throw new ToolInputError("old_string and new_string are identical");
    return a;
  },
  access(a, ctx) {
    const p = resolvePath(a.path, ctx);
    return { kind: "write", paths: [p], summary: `Edit ${display(p, ctx)}` };
  },
  async run(a, ctx) {
    const p = resolvePath(a.path, ctx);
    if (!existsSync(p)) return { content: `file not found: ${display(p, ctx)}`, isError: true };
    const stale = requireFreshRead(p, ctx);
    if (stale) return { content: stale, isError: true };
    const text = readFileSync(p, "utf8");
    const count = text.split(a.oldString).length - 1;
    if (count === 0)
      return { content: "old_string not found in the file; read it again and copy the text exactly", isError: true };
    if (count > 1 && !a.replaceAll) {
      return {
        content: `old_string occurs ${count} times; add surrounding lines to make it unique, or set replace_all`,
        isError: true,
      };
    }
    const next = a.replaceAll
      ? text.split(a.oldString).join(a.newString)
      : text.replace(a.oldString, () => a.newString);
    writeFileSync(p, next);
    ctx.readState.set(p, mtime(p));
    const d = diffSnippet(text, next);
    const n = a.replaceAll ? count : 1;
    return {
      content: `edited ${display(p, ctx)} (${plural(n, "replacement")}): ${plural(d.removed, "line")} removed, ${plural(d.added, "line")} added. Check this is what you meant:\n${d.text}`,
    };
  },
};
