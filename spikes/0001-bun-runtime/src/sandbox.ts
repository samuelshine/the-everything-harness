// Spawn-based OS sandbox (ADR-0001 spike, check 3).
// macOS: sandbox-exec with an SBPL profile. Linux: bubblewrap with --unshare-net.
// Policy: writes allowed only in the workspace and a private tmp dir; no network.

import { mkdtempSync, writeFileSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

export type SandboxResult = { name: string; ok: boolean; detail: string; skipped?: boolean };

function profile(workspace: string, tmp: string) {
  return `(version 1)
(allow default)
(deny network*)
(deny file-write*)
(allow file-write* (subpath "${workspace}") (subpath "${tmp}") (literal "/dev/null") (literal "/dev/stdout") (literal "/dev/stderr"))
`;
}

export function sandboxCommand(cmd: string, workspace: string, tmp: string): string[] | null {
  if (process.platform === "darwin") {
    return ["/usr/bin/sandbox-exec", "-p", profile(workspace, tmp), "/bin/bash", "-c", cmd];
  }
  if (process.platform === "linux") {
    return [
      "bwrap", "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
      "--bind", workspace, workspace, "--bind", tmp, tmp,
      "--unshare-net", "--die-with-parent", "--", "/bin/bash", "-c", cmd,
    ];
  }
  return null; // Windows: out of scope for the spike (ADR-0001 check 3 covers macOS + Linux).
}

function run(argv: string[], cwd: string, env: Record<string, string>) {
  const p = Bun.spawnSync(argv, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() };
}

export function runSandboxChecks(): SandboxResult[] {
  // Resolve symlinks (macOS /var -> /private/var): sandbox profiles match real paths.
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "spike-ws-")));
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), "spike-tmp-")));
  const outside = join(homedir(), `.spike-0001-should-not-exist-${process.pid}`);
  const probe = sandboxCommand("true", workspace, tmp);
  if (!probe) return [{ name: "sandbox available", ok: false, skipped: true, detail: `no sandbox backend for ${process.platform} (out of scope for this spike)` }];
  if (process.platform === "linux" && run(["bash", "-c", "command -v bwrap"], workspace, {}).code !== 0) {
    return [{ name: "sandbox available", ok: false, detail: "bwrap not installed" }];
  }
  const env = { TMPDIR: tmp };
  const exec = (cmd: string) => run(sandboxCommand(cmd, workspace, tmp)!, workspace, env);
  const results: SandboxResult[] = [];

  let r = exec("echo hi > inside.txt && cat inside.txt");
  results.push({ name: "write inside workspace allowed", ok: r.code === 0 && r.out.includes("hi"), detail: r.out.trim() });

  r = exec(`echo pwned > '${outside}'`);
  const leaked = existsSync(outside);
  if (leaked) rmSync(outside);
  results.push({ name: "write outside workspace denied", ok: r.code !== 0 && !leaked, detail: r.out.trim().slice(0, 160) });

  r = exec("curl -sS -m 5 -o /dev/null -w '%{http_code}' https://example.com");
  results.push({ name: "network denied (curl)", ok: r.code !== 0, detail: r.out.trim().slice(0, 160) });

  writeFileSync(join(workspace, "readme.txt"), "readable");
  r = exec("cat readme.txt && ls / > /dev/null");
  results.push({ name: "reads allowed", ok: r.code === 0 && r.out.includes("readable"), detail: r.out.trim().slice(0, 80) });

  return results;
}
