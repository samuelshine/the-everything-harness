// @-mentions in a prompt (ADR-0024): `@src/app.ts` attaches that file's text to the prompt,
// `@src/` a listing of the folder, as in Claude Code. The person typed the path, so no approval
// is asked, but deny rules for Read still apply. Images are left for the Read tool, which sends
// them to models that can see.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { decide, type PermissionConfig } from "./permissions";

export type MentionKind = "file" | "dir" | "image" | "missing" | "denied" | "binary";
export type Mention = { token: string; path: string; kind: MentionKind; note?: string };

const MAX_BYTES = 100_000;
const MAX_LINES = 2000;
const MAX_ENTRIES = 200;
const IMAGE = /\.(png|jpe?g|gif|webp)$/i;

// `@path` or `@"path with spaces"`, at the start or after whitespace. Trailing punctuation is
// dropped unless the path really ends with it.
const MENTION = /(^|\s)@("([^"]+)"|[^\s"]+)/g;

export function findMentions(text: string, cwd: string): { token: string; path: string }[] {
  const out: { token: string; path: string }[] = [];
  for (const m of text.matchAll(MENTION)) {
    const token = (m[2] as string).trim();
    let path = m[3] ?? token;
    if (!m[3] && !existsSync(resolve(cwd, path))) path = path.replace(/[.,;:!?)\]]+$/, "");
    if (path && !out.some((o) => o.path === path)) out.push({ token: `@${token}`, path });
  }
  return out;
}

const looksBinary = (buf: Buffer) => buf.subarray(0, 8000).includes(0);

export function expandMentions(
  text: string,
  opts: { cwd: string; permissions: PermissionConfig; home?: string },
): { prompt: string; mentions: Mention[] } {
  const mentions: Mention[] = [];
  const blocks: string[] = [];
  for (const { token, path } of findMentions(text, opts.cwd)) {
    const abs = isAbsolute(path) ? path : resolve(opts.cwd, path);
    const shown = relative(opts.cwd, abs).startsWith("..") ? abs : relative(opts.cwd, abs) || ".";
    if (!existsSync(abs)) {
      mentions.push({ token, path: shown, kind: "missing" });
      continue;
    }
    const decision = decide("Read", { kind: "read", paths: [abs], summary: `read ${shown}` }, opts.permissions, {
      cwd: opts.cwd,
      workspaceRoots: [opts.cwd],
      readState: new Map(),
    });
    if (decision.behavior === "deny") {
      mentions.push({ token, path: shown, kind: "denied", note: decision.reason });
      continue;
    }
    const st = statSync(abs);
    if (st.isDirectory()) {
      const entries = readdirSync(abs, { withFileTypes: true })
        .filter((e) => e.name !== ".git")
        .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
        .sort();
      const more = entries.length > MAX_ENTRIES ? `\n… and ${entries.length - MAX_ENTRIES} more` : "";
      blocks.push(`<directory path="${shown}">\n${entries.slice(0, MAX_ENTRIES).join("\n")}${more}\n</directory>`);
      mentions.push({ token, path: shown, kind: "dir" });
      continue;
    }
    if (IMAGE.test(abs)) {
      blocks.push(`<image path="${shown}">Use the Read tool on this path to see the image.</image>`);
      mentions.push({ token, path: shown, kind: "image" });
      continue;
    }
    const buf = readFileSync(abs);
    if (looksBinary(buf)) {
      mentions.push({ token, path: shown, kind: "binary" });
      continue;
    }
    let body = buf.subarray(0, MAX_BYTES).toString("utf8");
    const lines = body.split("\n");
    let note: string | undefined;
    if (lines.length > MAX_LINES || buf.length > MAX_BYTES) {
      body = lines.slice(0, MAX_LINES).join("\n");
      note = `first ${Math.min(lines.length, MAX_LINES)} lines; use Read with an offset for the rest`;
    }
    blocks.push(`<file path="${shown}"${note ? ` note="${note}"` : ""}>\n${body.replace(/\n$/, "")}\n</file>`);
    mentions.push({ token, path: shown, kind: "file", ...(note ? { note } : {}) });
  }
  if (!blocks.length) return { prompt: text, mentions };
  return { prompt: `${text}\n\nThe user attached these with @-mentions:\n${blocks.join("\n")}`, mentions };
}

// Paths under `root` for @ completion, from `git ls-files` when given, else a bounded walk.
export function listFiles(root: string, gitFiles?: string[], limit = 5000): string[] {
  if (gitFiles) return gitFiles.slice(0, limit);
  const out: string[] = [];
  const skip = new Set([".git", "node_modules", ".teh", "dist", "build", ".next", "target", ".venv"]);
  const walk = (dir: string) => {
    if (out.length >= limit) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limit) return;
      if (skip.has(e.name)) continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(root, p));
    }
  };
  walk(root);
  return out;
}

// The best matches for what follows "@": paths whose name starts with the query first, then
// paths containing it, then fuzzy (in-order letters). Folders are offered too.
export function rankFiles(files: string[], query: string, max = 8): string[] {
  const q = query.toLowerCase();
  const dirs = new Set<string>();
  for (const f of files) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) dirs.add(`${parts.slice(0, i).join("/")}/`);
  }
  const all = [...dirs, ...files];
  if (!q) return all.filter((f) => !f.slice(0, -1).includes("/")).slice(0, max);
  const score = (f: string): number => {
    const lower = f.toLowerCase();
    const base = lower.replace(/\/$/, "").split("/").pop() as string;
    if (lower.startsWith(q)) return 0;
    if (base.startsWith(q)) return 1;
    if (lower.includes(q)) return 2;
    let i = 0;
    for (const ch of lower) if (ch === q[i]) i++;
    return i === q.length ? 3 : -1;
  };
  return all
    .map((f) => [f, score(f)] as const)
    .filter(([, s]) => s >= 0)
    .sort((a, b) => a[1] - b[1] || a[0].length - b[0].length || a[0].localeCompare(b[0]))
    .slice(0, max)
    .map(([f]) => f);
}
