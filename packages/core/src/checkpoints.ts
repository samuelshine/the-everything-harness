// File checkpoints (ADR-0004): a shadow git repository per project snapshots the whole
// work tree, so changes made through Bash are covered as well as our own edit tools.
// It never touches the user's .git, index, branches or config.
import { existsSync, mkdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { projectKey } from "./session";

export const MAX_SNAPSHOT_FILE_BYTES = 10 * 1024 * 1024;
const REF = "refs/teh/checkpoints";

// Kept out of snapshots of projects that are not git repos (git repos use their .gitignore).
const NON_GIT_DEFAULT_IGNORES = ["node_modules/", ".venv/", "__pycache__/", ".DS_Store"];

// turn = before a run's first change, step = before a later step of the run, restore = before a restore.
export type CheckpointKind = "turn" | "step" | "restore";

export type Checkpoint = {
  sha: string;
  time: Date;
  kind: CheckpointKind;
  session: string;
  label: string;
};

export type RestorePlan = {
  target: Checkpoint;
  // Paths relative to the project root.
  write: string[];
  remove: string[];
  // Files the current snapshot does not cover (ignored or too large); restore leaves them alone.
  skipped: string[];
};

export class CheckpointError extends Error {}

export class CheckpointStore {
  readonly gitDir: string;

  constructor(
    home: string,
    readonly root: string,
    private readonly git = Bun.which("git"),
  ) {
    this.gitDir = join(home, "projects", projectKey(root), "shadow.git");
  }

  // Why checkpoints cannot run here, or undefined when they can.
  unavailable(): string | undefined {
    if (!this.git) return "git is not installed, so file changes cannot be undone";
    const r = resolve(this.root);
    if (r === resolve(homedir()) || r === resolve(sep) || dirname(r) === r)
      return `${r} is too broad to snapshot; run teh inside a project directory`;
    return undefined;
  }

  // Snapshot the work tree. Returns the existing checkpoint when nothing changed since it.
  async snapshot(kind: CheckpointKind, session: string, label: string): Promise<Checkpoint> {
    const why = this.unavailable();
    if (why) throw new CheckpointError(why);
    await this.init();
    this.writeExcludes([]);
    const large = await this.largeFiles();
    if (large.length) {
      this.writeExcludes(large);
      await this.run(["rm", "--cached", "-q", "--ignore-unmatch", "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: `${large.join("\0")}\0`,
      });
    }
    await this.run(["add", "-A"]);
    const tree = (await this.run(["write-tree"])).trim();
    const head = await this.head();
    if (head) {
      const headTree = (await this.run(["rev-parse", `${head}^{tree}`])).trim();
      if (headTree === tree) {
        const last = (await this.list(1))[0];
        if (last && last.kind === kind) return last;
      }
    }
    const message = `${oneLine(label) || "(no label)"}\n\nTeh-Kind: ${kind}\nTeh-Session: ${session}\n`;
    const sha = (
      await this.run(["commit-tree", tree, ...(head ? ["-p", head] : []), "-F", "-"], { stdin: message })
    ).trim();
    await this.run(["update-ref", REF, sha]);
    return { sha, time: new Date(), kind, session, label: oneLine(label) };
  }

  async list(limit = 50): Promise<Checkpoint[]> {
    if (!(await this.head())) return [];
    const out = await this.run(["log", `-n${limit}`, "--format=%H%x1f%ct%x1f%B%x1e", REF]);
    return out
      .split("\x1e")
      .map((r) => r.trim())
      .filter(Boolean)
      .map((r) => {
        const [sha = "", ct = "0", body = ""] = r.split("\x1f");
        const trailer = (k: string) => body.match(new RegExp(`^Teh-${k}: (.*)$`, "m"))?.[1] ?? "";
        return {
          sha,
          time: new Date(Number(ct) * 1000),
          kind: (trailer("Kind") || "turn") as CheckpointKind,
          session: trailer("Session"),
          label: body.split("\n")[0] ?? "",
        };
      });
  }

  async find(ref: string): Promise<Checkpoint | undefined> {
    if (!/^[0-9a-f]{4,40}$/i.test(ref)) return undefined;
    return (await this.list(10_000)).find((c) => c.sha.startsWith(ref.toLowerCase()));
  }

  // What restoring `target` would change, compared with `current` (a fresh snapshot).
  async plan(current: Checkpoint, target: Checkpoint): Promise<RestorePlan> {
    const out = await this.run(["diff", "--name-status", "--no-renames", "-z", current.sha, target.sha]);
    const parts = out.split("\0").filter(Boolean);
    const plan: RestorePlan = { target, write: [], remove: [], skipped: [] };
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const status = parts[i] ?? "";
      const path = parts[i + 1] ?? "";
      if (status === "D") plan.remove.push(path);
      else if (status === "A" && existsSync(join(this.root, path))) plan.skipped.push(path);
      else plan.write.push(path);
    }
    return plan;
  }

  // Apply a plan made against the current snapshot. Never touches files the snapshot skips.
  async apply(plan: RestorePlan): Promise<void> {
    if (plan.write.length) {
      await this.run(["checkout", plan.target.sha, "--pathspec-from-file=-", "--pathspec-file-nul"], {
        stdin: `${plan.write.join("\0")}\0`,
      });
    }
    for (const rel of plan.remove) {
      const abs = join(this.root, rel);
      rmSync(abs, { force: true });
      removeEmptyParents(dirname(abs), this.root);
    }
  }

  private async head(): Promise<string | undefined> {
    if (!existsSync(join(this.gitDir, "HEAD"))) return undefined;
    const out = await this.run(["rev-parse", "--verify", "-q", REF], { allowFail: true });
    return out.trim() || undefined;
  }

  private async init() {
    if (existsSync(join(this.gitDir, "HEAD"))) return;
    mkdirSync(dirname(this.gitDir), { recursive: true, mode: 0o700 });
    await this.run(["init", "-q", "--bare", this.gitDir], { noGitDir: true });
  }

  private writeExcludes(large: string[]) {
    const lines = ["# written by teh before each snapshot"];
    if (!existsSync(join(this.root, ".git"))) lines.push(...NON_GIT_DEFAULT_IGNORES);
    // Our GIT_DIR is the shadow repo, so the user's own .git/info/exclude must be copied in.
    const userExclude = join(this.root, ".git", "info", "exclude");
    if (existsSync(userExclude)) lines.push(readFileSync(userExclude, "utf8"));
    const custom = join(this.root, ".teh", "checkpoint-ignore");
    if (existsSync(custom)) lines.push(readFileSync(custom, "utf8"));
    lines.push(...large.map(literalPattern));
    mkdirSync(join(this.gitDir, "info"), { recursive: true });
    writeFileSync(join(this.gitDir, "info", "exclude"), `${lines.join("\n")}\n`);
  }

  // Untracked or modified files over the size limit.
  private async largeFiles(): Promise<string[]> {
    const listed = await this.run(["ls-files", "-z", "--others", "--modified", "--exclude-standard"]);
    const large: string[] = [];
    for (const rel of new Set(listed.split("\0").filter(Boolean))) {
      try {
        if (statSync(join(this.root, rel)).size > MAX_SNAPSHOT_FILE_BYTES) large.push(rel);
      } catch {
        // deleted since listing
      }
    }
    return large;
  }

  private async run(args: string[], opts: { stdin?: string; allowFail?: boolean; noGitDir?: boolean } = {}) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("GIT_")) env[k] = v;
    Object.assign(env, {
      GIT_AUTHOR_NAME: "teh",
      GIT_AUTHOR_EMAIL: "teh@localhost",
      GIT_COMMITTER_NAME: "teh",
      GIT_COMMITTER_EMAIL: "teh@localhost",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_TERMINAL_PROMPT: "0",
    });
    if (!opts.noGitDir) Object.assign(env, { GIT_DIR: this.gitDir, GIT_WORK_TREE: this.root });
    const config = [
      "core.autocrlf=false",
      "core.safecrlf=false",
      "core.fsmonitor=false",
      "core.quotepath=false",
      "core.hooksPath=",
      "commit.gpgSign=false",
      "gc.auto=0",
      "advice.addEmbeddedRepo=false",
    ].flatMap((c) => ["-c", c]);
    const proc = Bun.spawn([this.git as string, ...config, ...args], {
      cwd: this.root,
      env,
      stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (code !== 0 && !opts.allowFail) {
      throw new CheckpointError(`git ${args[0]} failed: ${err.trim() || `exit code ${code}`}`);
    }
    return out;
  }
}

function oneLine(s: string): string {
  const line = s.replace(/\s+/g, " ").trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}

// An exclude pattern matching exactly one path.
function literalPattern(rel: string): string {
  const escaped = rel.replace(/[\\*?[\]]/g, "\\$&").replace(/ +$/, (m) => "\\ ".repeat(m.length));
  return `/${escaped}`;
}

function removeEmptyParents(dir: string, root: string) {
  let d = dir;
  while (d.startsWith(root + sep)) {
    try {
      rmdirSync(d);
    } catch {
      return;
    }
    d = dirname(d);
  }
}
