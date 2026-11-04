// OS sandbox for shell commands (ADR-0003). Approval decides whether a command runs; the
// sandbox limits what it can do once it does:
//   read-only        commands teh judged read-only and ran without asking. No writes outside
//                    the temp folder, no network, and common secret folders are hidden. A
//                    classifier mistake (or a repo's git config running a pager) can't do harm.
//   workspace-write  commands the user or a rule allowed. Writes only inside the workspace,
//                    the temp folder and package caches; teh's own settings, the agent's
//                    config folders and git hooks stay read-only. Network per settings.
// macOS uses Seatbelt (sandbox-exec), Linux uses bubblewrap. Windows has none yet (ADR-0013).
import { existsSync, realpathSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

export type SandboxLevel = "read-only" | "workspace-write";

export type SandboxPolicy = {
  // Folders commands may write to at workspace-write (the workspace roots, --add-dir).
  workspaceRoots: string[];
  // Extra writable folders from settings (sandbox.allowWrite).
  allowWrite?: string[];
  // Network for workspace-write commands. Read-only commands never get it.
  network: boolean;
  // Paths no command may read (from Read deny rules without wildcards).
  denyRead?: string[];
  home?: string;
};

export type SandboxKind = "seatbelt" | "bubblewrap";

export type Sandbox = {
  kind: SandboxKind;
  // The command line that runs argv inside the sandbox.
  wrap(argv: string[], level: SandboxLevel, cwd: string): string[];
  // Human-readable summary, for `teh permissions` and the model's error hints.
  describe(level: SandboxLevel): string;
};

// Writable at workspace-write besides the workspace: package-manager caches, so installs work.
const CACHE_DIRS = [
  ".cache",
  ".npm",
  ".bun/install/cache",
  ".pnpm-store",
  ".yarn",
  ".cargo/registry",
  ".cargo/git",
  "go/pkg/mod",
  ".gradle/caches",
  ".m2/repository",
  "Library/Caches",
];
// Hidden from read-only commands: credentials a read never needs.
const SECRET_DIRS = [
  ".ssh",
  ".aws",
  ".gnupg",
  ".azure",
  ".kube",
  ".docker/config.json",
  ".config/gh",
  ".config/gcloud",
  ".netrc",
  ".git-credentials",
  ".npmrc",
  ".pypirc",
  ".claude/.credentials.json",
  ".codex/auth.json",
];
// Inside each workspace root, kept read-only even for allowed commands: the agent's own
// settings and skills, and git hooks/config, which would run code on the user's next git command.
const PROTECTED_IN_ROOT = [".teh", ".claude", ".agents", ".git/hooks", ".git/config"];

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return p;
  }
}

function tempDirs(): string[] {
  const dirs = new Set([canonical(tmpdir())]);
  if (process.platform !== "win32") dirs.add(canonical("/tmp"));
  return [...dirs];
}

type Plan = {
  writable: string[];
  protect: string[];
  hide: string[];
  network: boolean;
};

export function sandboxPlan(policy: SandboxPolicy, level: SandboxLevel): Plan {
  const home = canonical(policy.home ?? homedir());
  const roots = [...new Set(policy.workspaceRoots.map(canonical))];
  const writable =
    level === "read-only"
      ? tempDirs()
      : [
          ...roots,
          ...tempDirs(),
          ...CACHE_DIRS.map((d) => join(home, d)).filter(existsSync),
          ...(policy.allowWrite ?? []).map(canonical),
        ];
  const protect = roots.flatMap((r) => PROTECTED_IN_ROOT.map((d) => join(r, d)));
  const hide = [
    ...(level === "read-only" ? SECRET_DIRS.map((d) => join(home, d)) : []),
    ...(policy.denyRead ?? []).map(canonical),
  ];
  return {
    writable: [...new Set(writable)],
    protect,
    hide: [...new Set(hide)],
    network: level === "workspace-write" && policy.network,
  };
}

// --- macOS: Seatbelt -------------------------------------------------------------------

function sbString(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function seatbeltProfile(plan: Plan): string {
  const lines = [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    `(allow file-write* (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper") (regex #"^/dev/tty") (regex #"^/dev/fd/"))`,
  ];
  if (plan.writable.length)
    lines.push(`(allow file-write* ${plan.writable.map((p) => `(subpath ${sbString(p)})`).join(" ")})`);
  // Later rules win, so protected paths stay read-only inside writable roots, and the rule
  // also stops them from being created.
  if (plan.protect.length)
    lines.push(`(deny file-write* ${plan.protect.map((p) => `(subpath ${sbString(p)})`).join(" ")})`);
  if (plan.hide.length) lines.push(`(deny file-read* ${plan.hide.map((p) => `(subpath ${sbString(p)})`).join(" ")})`);
  if (!plan.network) {
    lines.push("(deny network*)");
    // Local Unix sockets (e.g. a git credential cache) are not the network.
    lines.push("(allow network* (remote unix-socket))");
  }
  return lines.join("\n");
}

// --- Linux: bubblewrap -----------------------------------------------------------------

export function bubblewrapArgs(plan: Plan, cwd: string): string[] {
  const args = ["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--die-with-parent"];
  for (const p of plan.writable) if (existsSync(p)) args.push("--bind", p, p);
  // bubblewrap can only re-mount paths that exist, so a protected folder that doesn't exist
  // yet can be created (Seatbelt blocks that too). Its contents are protected once it does.
  for (const p of plan.protect) if (existsSync(p)) args.push("--ro-bind", p, p);
  for (const p of plan.hide) {
    if (!existsSync(p)) continue;
    // An empty folder, or /dev/null, in place of the secret.
    if (statSync(p).isDirectory()) args.push("--tmpfs", p);
    else args.push("--ro-bind", "/dev/null", p);
  }
  if (!plan.network) args.push("--unshare-net");
  args.push("--chdir", cwd);
  return args;
}

// --- Detection ---------------------------------------------------------------------------

let bwrapWorks: boolean | undefined;

function bubblewrapUsable(bwrap: string): boolean {
  if (bwrapWorks !== undefined) return bwrapWorks;
  try {
    const r = Bun.spawnSync([bwrap, "--ro-bind", "/", "/", "--dev", "/dev", "--unshare-net", "true"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    bwrapWorks = r.exitCode === 0;
  } catch {
    bwrapWorks = false;
  }
  return bwrapWorks;
}

export type SandboxAvailability = { sandbox: Sandbox } | { unavailable: string };

export function detectSandbox(policy: SandboxPolicy): SandboxAvailability {
  const describe = (level: SandboxLevel) => {
    const p = sandboxPlan(policy, level);
    return level === "read-only"
      ? "read-only: no file writes outside the temp folder, no network, credential folders hidden"
      : `writes only inside the workspace, temp and package caches; .teh, .claude, .agents and .git hooks/config read-only; network ${p.network ? "on" : "off"}`;
  };
  if (process.platform === "darwin") {
    const exe = "/usr/bin/sandbox-exec";
    if (!existsSync(exe)) return { unavailable: "sandbox-exec was not found" };
    return {
      sandbox: {
        kind: "seatbelt",
        wrap: (argv, level) => [exe, "-p", seatbeltProfile(sandboxPlan(policy, level)), ...argv],
        describe,
      },
    };
  }
  if (process.platform === "linux") {
    const bwrap = Bun.which("bwrap");
    if (!bwrap) return { unavailable: "bubblewrap is not installed (e.g. `sudo apt install bubblewrap`)" };
    if (!bubblewrapUsable(bwrap)) {
      return {
        unavailable:
          "bubblewrap cannot create a sandbox here (unprivileged user namespaces may be disabled, e.g. by AppArmor)",
      };
    }
    return {
      sandbox: {
        kind: "bubblewrap",
        wrap: (argv, level, cwd) => [bwrap, ...bubblewrapArgs(sandboxPlan(policy, level), cwd), "--", ...argv],
        describe,
      },
    };
  }
  return { unavailable: `no sandbox for ${process.platform} yet` };
}
