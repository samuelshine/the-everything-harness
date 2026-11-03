// Glob and Grep. Grep uses ripgrep when installed and falls back to a built-in scan.
import { readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { display, obj, resolvePath, str, type Tool, type ToolContext, ToolInputError, truncate } from "./tool";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", ".teh"]);
const MAX_RESULTS = 200;

function skipped(rel: string): boolean {
  return rel.split(/[\\/]/).some((part) => SKIP_DIRS.has(part));
}

type GlobArgs = { pattern: string; path?: string };

export const globTool: Tool<GlobArgs> = {
  spec: {
    name: "Glob",
    description: `Find files by glob pattern (e.g. "src/**/*.ts"). Returns up to ${MAX_RESULTS} paths, most recently modified first. Skips .git and node_modules.`,
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern" },
        path: { type: "string", description: "Directory to search (default: working directory)" },
      },
      required: ["pattern"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    const path = str(o, "path", true);
    return { pattern: str(o, "pattern"), ...(path ? { path } : {}) };
  },
  access(a, ctx) {
    const base = resolvePath(a.path ?? ".", ctx);
    return { kind: "read", paths: [base], summary: `Glob ${a.pattern} in ${display(base, ctx)}` };
  },
  async run(a, ctx) {
    const base = resolvePath(a.path ?? ".", ctx);
    const found: { path: string; mtime: number }[] = [];
    for await (const rel of new Bun.Glob(a.pattern).scan({ cwd: base, onlyFiles: true })) {
      if (skipped(rel)) continue;
      const abs = join(base, rel);
      found.push({ path: abs, mtime: statSync(abs).mtimeMs });
    }
    if (found.length === 0) return { content: "no files matched" };
    found.sort((x, y) => y.mtime - x.mtime);
    const shown = found.slice(0, MAX_RESULTS).map((f) => display(f.path, ctx));
    const more = found.length > MAX_RESULTS ? `\n(${found.length - MAX_RESULTS} more not shown)` : "";
    return { content: shown.join("\n") + more };
  },
};

type GrepMode = "content" | "files_with_matches" | "count";
type GrepArgs = { pattern: string; path?: string; glob?: string; mode: GrepMode; ignoreCase: boolean };

export const grepTool: Tool<GrepArgs> = {
  spec: {
    name: "Grep",
    description:
      "Search file contents with a regular expression. output_mode: files_with_matches (default), content (matching lines with line numbers) or count.",
    inputSchema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Regular expression" },
        path: { type: "string", description: "File or directory to search (default: working directory)" },
        glob: { type: "string", description: 'Only search files matching this glob, e.g. "*.ts"' },
        output_mode: { type: "string", enum: ["content", "files_with_matches", "count"] },
        case_insensitive: { type: "boolean" },
      },
      required: ["pattern"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    const mode = (str(o, "output_mode", true) ?? "files_with_matches") as GrepMode;
    if (!["content", "files_with_matches", "count"].includes(mode)) throw new ToolInputError("invalid output_mode");
    const pattern = str(o, "pattern");
    try {
      new RegExp(pattern);
    } catch {
      throw new ToolInputError(`invalid regular expression: ${pattern}`);
    }
    const path = str(o, "path", true);
    const glob = str(o, "glob", true);
    return {
      pattern,
      mode,
      ignoreCase: o.case_insensitive === true,
      ...(path ? { path } : {}),
      ...(glob ? { glob } : {}),
    };
  },
  access(a, ctx) {
    const base = resolvePath(a.path ?? ".", ctx);
    return { kind: "read", paths: [base], summary: `Grep /${a.pattern}/ in ${display(base, ctx)}` };
  },
  async run(a, ctx) {
    const out = Bun.which("rg") ? await ripgrep(a, ctx) : await scan(a, ctx);
    return { content: out.trim() ? truncate(out.trim()) : "no matches" };
  },
};

async function ripgrep(a: GrepArgs, ctx: ToolContext): Promise<string> {
  const args = ["rg", "--color", "never", "--no-heading", "--max-columns", "500"];
  if (a.ignoreCase) args.push("-i");
  if (a.glob) args.push("--glob", a.glob);
  if (a.mode === "files_with_matches") args.push("-l");
  else if (a.mode === "count") args.push("-c");
  else args.push("-n");
  args.push("--", a.pattern, resolvePath(a.path ?? ".", ctx));
  const p = Bun.spawn(args, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code === 2) throw new Error(stderr.trim() || "ripgrep failed");
  // Show paths relative to the working directory, as Glob does.
  return stdout
    .split("\n")
    .map((line) => {
      const colon = a.mode === "files_with_matches" ? line.length : line.indexOf(":");
      return colon > 0 ? display(line.slice(0, colon), ctx) + line.slice(colon) : line;
    })
    .join("\n");
}

export async function scan(a: GrepArgs, ctx: ToolContext): Promise<string> {
  const base = resolvePath(a.path ?? ".", ctx);
  const re = new RegExp(a.pattern, a.ignoreCase ? "i" : "");
  const filter = a.glob ? new Bun.Glob(a.glob.includes("/") ? a.glob : `**/${a.glob}`) : undefined;
  const files = statSync(base).isFile()
    ? [base]
    : await Array.fromAsync(new Bun.Glob("**/*").scan({ cwd: base, onlyFiles: true, dot: true }), (rel) =>
        join(base, rel),
      );
  const out: string[] = [];
  for (const file of files.sort()) {
    const rel = relative(base, file);
    if (skipped(rel) || (filter && !filter.match(rel.replaceAll("\\", "/")))) continue;
    if (statSync(file).size > 1_000_000) continue;
    const buf = readFileSync(file);
    if (buf.subarray(0, 8192).includes(0)) continue;
    const lines = buf.toString("utf8").split("\n");
    const hits = lines.flatMap((l, i) => (re.test(l) ? [`${display(file, ctx)}:${i + 1}:${l.slice(0, 500)}`] : []));
    if (hits.length === 0) continue;
    if (a.mode === "files_with_matches") out.push(display(file, ctx));
    else if (a.mode === "count") out.push(`${display(file, ctx)}:${hits.length}`);
    else out.push(...hits);
  }
  return out.join("\n");
}
