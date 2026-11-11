// Bash. Runs in the working directory. Not sandboxed yet (ADR-0003); commands need approval
// unless they are read-only or a rule allows them.
import { int, obj, str, type Tool, ToolInputError, truncate } from "./tool";

const DEFAULT_TIMEOUT_MS = 120_000;
const SANDBOX_DENIAL =
  /Operation not permitted|Read-only file system|Permission denied|Could not resolve host|Network is unreachable|Temporary failure in name resolution|sandbox/i;
const MAX_TIMEOUT_MS = 600_000;

type BashArgs = { command: string; timeoutMs: number; description?: string };

// Commands run in bash; on Windows without bash they fall back to cmd.exe, whose syntax
// the permission engine does not parse, so no command is treated as read-only there.
export function posixShell(): boolean {
  return process.platform !== "win32" || Bun.which("bash") !== null;
}

export function shellArgv(command: string): string[] {
  if (!posixShell()) return ["cmd.exe", "/d", "/s", "/c", command];
  return ["bash", "-c", command];
}

export const bashTool: Tool<BashArgs> = {
  spec: {
    name: "Bash",
    description: `Run a shell command in the working directory and return its output and exit code. Default timeout ${DEFAULT_TIMEOUT_MS / 1000}s, max ${MAX_TIMEOUT_MS / 1000}s. Prefer Read, Grep and Glob over cat, grep and find.`,
    inputSchema: {
      type: "object",
      properties: {
        command: { type: "string", description: "The command to run" },
        timeout: { type: "integer", description: "Timeout in milliseconds" },
        description: { type: "string", description: "Five to ten words on what the command does" },
      },
      required: ["command"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    const command = str(o, "command").trim();
    if (!command) throw new ToolInputError("command must not be empty");
    const timeoutMs = Math.min(int(o, "timeout") ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
    const description = str(o, "description", true);
    return { command, timeoutMs, ...(description ? { description } : {}) };
  },
  access(a) {
    return { kind: "execute", command: a.command, summary: `Run \`${a.command}\`` };
  },
  async run(a, ctx) {
    const level = ctx.sandboxLevel ?? "workspace-write";
    const argv = ctx.sandbox ? ctx.sandbox.wrap(shellArgv(a.command), level, ctx.cwd) : shellArgv(a.command);
    const p = Bun.spawn(argv, { cwd: ctx.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill();
    }, a.timeoutMs);
    const onAbort = () => p.kill();
    ctx.signal?.addEventListener("abort", onAbort);
    try {
      const [stdout, stderr, code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      const parts = [stdout.trimEnd(), stderr.trimEnd() && `[stderr]\n${stderr.trimEnd()}`].filter(Boolean);
      const status = timedOut ? `timed out after ${a.timeoutMs} ms` : `exit code ${code}`;
      const failed = timedOut || code !== 0;
      // Tell the model why, so it explains the limit instead of retrying blindly.
      if (failed && ctx.sandbox && SANDBOX_DENIAL.test(stderr)) {
        parts.push(
          `[sandbox: this command ran ${level}: ${ctx.sandbox.describe(level)}. If it needs more, tell the user; do not try to work around the sandbox]`,
        );
      }
      return { content: truncate([...parts, `[${status}]`].join("\n")), isError: failed };
    } finally {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
    }
  },
};
