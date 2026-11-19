// Background shells (ADR-0022): `Bash` with run_in_background starts a command and returns at
// once; BashOutput reads what it has printed since the last look, and KillShell stops it
// (Claude Code's names, ADR-0010). Dev servers, watchers and long builds no longer block a turn.
// The registry belongs to the session: the interactive UI keeps one across prompts, a headless
// run has its own, and every shell is killed when its owner closes.
import { obj, str, type Tool, ToolInputError, truncate } from "./tool";

const MAX_BUFFER = 1024 * 1024; // per shell; older output is dropped
const MAX_READ = 30_000;

export type ShellInfo = {
  id: string;
  command: string;
  started: number;
  status: "running" | "exited" | "killed";
  exitCode?: number;
};

type Shell = ShellInfo & {
  proc: ReturnType<typeof Bun.spawn>;
  out: string; // unread output, stdout and stderr interleaved as they arrive
  dropped: number; // characters dropped from `out` because nobody read them in time
};

export class ShellRegistry {
  private readonly shells = new Map<string, Shell>();
  private next = 1;
  private readonly listeners = new Set<() => void>();

  start(argv: string[], command: string, cwd: string): ShellInfo {
    const id = `bash_${this.next++}`;
    const proc = Bun.spawn(argv, {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      stdin: "ignore",
      detached: process.platform !== "win32",
    });
    const shell: Shell = { id, command, started: Date.now(), status: "running", proc, out: "", dropped: 0 };
    this.shells.set(id, shell);
    const pump = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        shell.out += prefix ? text.replace(/^(?=.)/gm, prefix) : text;
        if (shell.out.length > MAX_BUFFER) {
          shell.dropped += shell.out.length - MAX_BUFFER;
          shell.out = shell.out.slice(-MAX_BUFFER);
        }
      }
    };
    void Promise.all([
      pump(proc.stdout as ReadableStream<Uint8Array>, ""),
      pump(proc.stderr as ReadableStream<Uint8Array>, "[stderr] "),
      proc.exited,
    ]).then(([, , code]) => {
      if (shell.status === "running") {
        shell.status = "exited";
        shell.exitCode = code;
      }
      this.changed();
    });
    this.changed();
    return this.info(shell);
  }

  // New output since the last read, optionally only the lines matching `filter`.
  read(id: string, filter?: RegExp): { info: ShellInfo; output: string; dropped: number } | undefined {
    const shell = this.shells.get(id);
    if (!shell) return undefined;
    let output = shell.out;
    const dropped = shell.dropped;
    shell.out = "";
    shell.dropped = 0;
    if (filter)
      output = output
        .split("\n")
        .filter((l) => filter.test(l))
        .join("\n");
    return { info: this.info(shell), output, dropped };
  }

  kill(id: string): ShellInfo | undefined {
    const shell = this.shells.get(id);
    if (!shell) return undefined;
    if (shell.status === "running") {
      shell.status = "killed";
      killTree(shell.proc);
      this.changed();
    }
    return this.info(shell);
  }

  list(): ShellInfo[] {
    return [...this.shells.values()].map((s) => this.info(s));
  }

  get running(): number {
    return [...this.shells.values()].filter((s) => s.status === "running").length;
  }

  killAll(): void {
    for (const s of this.shells.values()) if (s.status === "running") this.kill(s.id);
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  private info(s: Shell): ShellInfo {
    return {
      id: s.id,
      command: s.command,
      started: s.started,
      status: s.status,
      ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}),
    };
  }
}

// The shell runs in its own process group, so its children (a dev server under npm) stop too.
function killTree(proc: ReturnType<typeof Bun.spawn>) {
  try {
    if (process.platform !== "win32" && proc.pid) process.kill(-proc.pid, "SIGTERM");
    else proc.kill();
  } catch {
    proc.kill();
  }
}

export function describeShell(s: ShellInfo): string {
  const secs = Math.round((Date.now() - s.started) / 1000);
  const state = s.status === "running" ? `running ${secs}s` : s.status === "killed" ? "killed" : `exited ${s.exitCode}`;
  return `${s.id} · ${state} · ${s.command}`;
}

type OutputArgs = { id: string; filter?: RegExp };

export const bashOutputTool: Tool<OutputArgs> = {
  spec: {
    name: "BashOutput",
    description:
      "Read new output from a background shell started with Bash run_in_background: only what it printed since you last read it, and whether it is still running. Optionally keep only lines matching a regular expression.",
    inputSchema: {
      type: "object",
      properties: {
        bash_id: { type: "string", description: "The shell's id, e.g. bash_1" },
        filter: { type: "string", description: "A regular expression; only matching lines are returned" },
      },
      required: ["bash_id"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    const f = str(o, "filter", true);
    let filter: RegExp | undefined;
    if (f) {
      try {
        filter = new RegExp(f);
      } catch {
        throw new ToolInputError(`"${f}" is not a valid regular expression`);
      }
    }
    return { id: str(o, "bash_id"), ...(filter ? { filter } : {}) };
  },
  access: (a) => ({ kind: "read", paths: [], summary: `Output of ${a.id}` }),
  async run(a, ctx) {
    const r = ctx.shells?.read(a.id, a.filter);
    if (!r) return { content: `no background shell ${a.id}${listing(ctx.shells)}`, isError: true };
    const status =
      r.info.status === "running"
        ? "still running"
        : r.info.status === "killed"
          ? "killed"
          : `exited with code ${r.info.exitCode}`;
    const lost = r.dropped ? `[${r.dropped} earlier characters were dropped unread]\n` : "";
    const body = r.output.trimEnd() ? truncate(r.output.trimEnd(), MAX_READ) : "(no new output)";
    return { content: `${lost}${body}\n[${a.id}: ${status}]` };
  },
};

export const killShellTool: Tool<{ id: string }> = {
  spec: {
    name: "KillShell",
    description: "Stop a background shell started with Bash run_in_background, and its child processes.",
    inputSchema: {
      type: "object",
      properties: { shell_id: { type: "string", description: "The shell's id, e.g. bash_1" } },
      required: ["shell_id"],
    },
  },
  parse(raw) {
    const o = obj(raw);
    return { id: str(o, "shell_id", true) ?? str(o, "bash_id") };
  },
  // Stopping a process teh started changes nothing the user owns.
  access: (a) => ({ kind: "read", paths: [], summary: `Kill ${a.id}` }),
  async run(a, ctx) {
    const s = ctx.shells?.kill(a.id);
    if (!s) return { content: `no background shell ${a.id}${listing(ctx.shells)}`, isError: true };
    return { content: s.status === "killed" ? `killed ${a.id}` : `${a.id} had already exited (code ${s.exitCode})` };
  },
};

function listing(shells: ShellRegistry | undefined): string {
  const all = shells?.list() ?? [];
  return all.length ? `; shells: ${all.map((s) => s.id).join(", ")}` : "; none have been started";
}
