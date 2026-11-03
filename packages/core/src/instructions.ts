// Project instruction files (ADR-0010, research doc 12 §6). The same text goes to
// every provider, so nothing needs maintaining per model.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// Loaded from the project root down to the working directory, in this order per directory.
const FILES = ["AGENTS.md", "CLAUDE.md", join(".claude", "CLAUDE.md"), "CLAUDE.local.md"];
const MAX_IMPORT_DEPTH = 4; // Same limit as Claude Code's @imports.

export type InstructionFile = { path: string; content: string; importedBy?: string };

export function findProjectRoot(cwd: string): string {
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    if (dirname(dir) === dir) return resolve(cwd);
  }
}

export function loadInstructions(cwd: string, opts: { userFile?: string; maxChars?: number } = {}): InstructionFile[] {
  const root = findProjectRoot(cwd);
  const dirs: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === root || dirname(dir) === dir) break;
  }

  const loaded = new Set<string>();
  const out: InstructionFile[] = [];
  const add = (path: string, depth: number, importedBy?: string) => {
    const abs = resolve(path);
    if (loaded.has(abs) || !existsSync(abs) || !statSync(abs).isFile()) return;
    loaded.add(abs);
    const content = readFileSync(abs, "utf8");
    out.push(importedBy ? { path: abs, content, importedBy } : { path: abs, content });
    if (depth >= MAX_IMPORT_DEPTH) return;
    for (const target of findImports(content)) {
      add(isAbsolute(target) ? target : join(dirname(abs), target), depth + 1, abs);
    }
  };

  if (opts.userFile) add(opts.userFile, 0);
  for (const dir of dirs) for (const name of FILES) add(join(dir, name), 0);
  return budget(out, opts.maxChars ?? 40_000);
}

// `@path` references outside code fences and inline code, as in Claude Code.
export function findImports(content: string): string[] {
  const targets: string[] = [];
  let fenced = false;
  for (const line of content.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    const text = line.replace(/`[^`]*`/g, "");
    for (const m of text.matchAll(/(?:^|\s)@((?:\\ |[^\s])+)/g)) {
      const target = (m[1] as string).replace(/\\ /g, " ");
      if (target.includes("/") || target.includes(".")) targets.push(target);
    }
  }
  return targets;
}

// Keep files whole while they fit; then truncate the rest and say so (small local windows).
function budget(files: InstructionFile[], maxChars: number): InstructionFile[] {
  let used = 0;
  return files.map((f) => {
    const left = Math.max(0, maxChars - used);
    used += f.content.length;
    if (f.content.length <= left) return f;
    return {
      ...f,
      content: `${f.content.slice(0, left)}\n\n[truncated: instruction budget of ${maxChars} characters reached]`,
    };
  });
}

export function renderInstructions(files: InstructionFile[], cwd: string): string {
  return files
    .map((f) => {
      const rel = relative(cwd, f.path) || f.path;
      const via = f.importedBy ? ` (imported by ${relative(cwd, f.importedBy) || f.importedBy})` : "";
      return `<instructions source="${rel}"${via}>\n${f.content.trim()}\n</instructions>`;
    })
    .join("\n\n");
}
