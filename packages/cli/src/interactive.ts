// What the interactive UI needs from the machine (ADR-0024): prompt history on disk, the
// person's shell for `!`, their editor for Ctrl+G, the clipboard for images, and terminal
// feature detection. Kept out of packages/tui so the UI stays testable without a real machine.
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// --- Prompt history ----------------------------------------------------------------------
// ~/.teh/history.jsonl: one {project, text, at} per prompt, so Up and Ctrl+R reach prompts
// from earlier sessions in the same project, as in Claude Code.

const HISTORY_KEEP = 500;

export function promptHistory(home: string, project: string): { entries: string[]; add(text: string): void } {
  const file = join(home, "history.jsonl");
  const entries: string[] = [];
  if (existsSync(file)) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (!line) continue;
      try {
        const e = JSON.parse(line) as { project?: string; text?: string };
        if (e.project === project && typeof e.text === "string" && entries.at(-1) !== e.text) entries.push(e.text);
      } catch {}
    }
  }
  return {
    entries: entries.slice(-HISTORY_KEEP),
    add(text: string) {
      try {
        mkdirSync(home, { recursive: true });
        appendFileSync(file, `${JSON.stringify({ project, text, at: new Date().toISOString() })}\n`, { mode: 0o600 });
      } catch {}
    },
  };
}

// --- `!` commands ------------------------------------------------------------------------
// The person typed the command, so it runs as they would run it: their shell, no sandbox and
// no approval, as in Claude Code's bash mode.
export function shellRunner(cwd: string, env: Record<string, string | undefined>) {
  return async (command: string, signal: AbortSignal): Promise<{ output: string; code: number | null }> => {
    const shell = env.SHELL || "/bin/sh";
    const proc = Bun.spawn([shell, "-c", command], {
      cwd,
      env: env as Record<string, string>,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const stop = () => proc.kill();
    signal.addEventListener("abort", stop, { once: true });
    const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    const code = await proc.exited;
    signal.removeEventListener("abort", stop);
    return { output: out + err, code: proc.signalCode ? null : code };
  };
}

// --- Ctrl+G ------------------------------------------------------------------------------
// $VISUAL or $EDITOR edits the prompt in a temporary file. Returns the text, or undefined when
// no editor is set or it failed.
export function externalEditor(env: Record<string, string | undefined>) {
  const editor = env.VISUAL || env.EDITOR;
  if (!editor) return undefined;
  return (text: string): string | undefined => {
    const dir = join(tmpdir(), `teh-prompt-${process.pid}`);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "prompt.md");
    writeFileSync(file, text);
    try {
      // Through the shell, so EDITOR="code --wait" works; the file is passed as $1, unquoted text never.
      const r = Bun.spawnSync(["/bin/sh", "-c", `${editor} "$1"`, "teh-editor", file], {
        stdio: ["inherit", "inherit", "inherit"],
        env: env as Record<string, string>,
      });
      return r.exitCode === 0 ? readFileSync(file, "utf8") : undefined;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// --- Ctrl+V ------------------------------------------------------------------------------
// Saves the clipboard's image as a PNG under ~/.teh/cache/pasted and returns its path.
export function clipboardImage(home: string, platform = process.platform) {
  return async (): Promise<string | undefined> => {
    const dir = join(home, "cache", "pasted");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
    const run = (cmd: string[]) => {
      try {
        return Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" });
      } catch {
        return undefined;
      }
    };
    if (platform === "darwin") {
      const r = run([
        "osascript",
        "-e",
        `set f to open for access POSIX file ${JSON.stringify(file)} with write permission`,
        "-e",
        "try",
        "-e",
        "write (the clipboard as «class PNGf») to f",
        "-e",
        "on error",
        "-e",
        "close access f",
        "-e",
        "error number -128",
        "-e",
        "end try",
        "-e",
        "close access f",
      ]);
      if (r?.exitCode !== 0) {
        rmSync(file, { force: true });
        return undefined;
      }
    } else {
      const r = run(["wl-paste", "--no-newline", "--type", "image/png"]) ?? undefined;
      const x = r?.exitCode === 0 ? r : run(["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]);
      if (x?.exitCode !== 0 || !x.stdout.length) return undefined;
      writeFileSync(file, x.stdout);
    }
    return existsSync(file) && readFileSync(file).subarray(0, 4).toString("hex") === "89504e47" ? file : undefined;
  };
}

// --- Terminal features -------------------------------------------------------------------
// OSC 8 links in terminals known to show them. TEH_HYPERLINKS=1 or 0 overrides.
export function supportsHyperlinks(env: Record<string, string | undefined>): boolean {
  if (env.TEH_HYPERLINKS === "1") return true;
  if (env.TEH_HYPERLINKS === "0") return false;
  if (env.TMUX || env.STY) return false;
  const program = env.TERM_PROGRAM ?? "";
  if (["iTerm.app", "WezTerm", "vscode", "ghostty", "Hyper", "rio"].includes(program)) return true;
  if (env.WT_SESSION || env.KITTY_WINDOW_ID || env.KONSOLE_VERSION) return true;
  if (Number(env.VTE_VERSION ?? 0) >= 5000) return true;
  return /^(xterm-kitty|xterm-ghostty|alacritty|foot)/.test(env.TERM ?? "");
}
