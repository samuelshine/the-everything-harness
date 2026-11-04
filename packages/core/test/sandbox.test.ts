import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bubblewrapArgs, detectSandbox, type SandboxLevel, sandboxPlan, seatbeltProfile } from "../src/sandbox";
import { bashTool } from "../src/tools/bash";
import { toolContext } from "./helpers";

describe("sandbox plans", () => {
  const policy = { workspaceRoots: ["/w"], network: true, home: "/h", denyRead: ["/w/.env"] };

  test("read-only commands get no workspace writes, no network and no credentials", () => {
    const p = sandboxPlan(policy, "read-only");
    expect(p.writable).not.toContain("/w");
    expect(p.network).toBe(false);
    expect(p.hide).toContain("/h/.ssh");
    expect(p.hide).toContain("/w/.env");
  });

  test("allowed commands may write the workspace, but not teh's or git's control files", () => {
    const p = sandboxPlan(policy, "workspace-write");
    expect(p.writable).toContain("/w");
    expect(p.protect).toEqual(expect.arrayContaining(["/w/.teh", "/w/.claude", "/w/.git/hooks", "/w/.git/config"]));
    expect(p.network).toBe(true);
    expect(p.hide).not.toContain("/h/.ssh");
    expect(sandboxPlan({ ...policy, network: false }, "workspace-write").network).toBe(false);
  });

  test("the Seatbelt profile denies writes by default and protects after allowing", () => {
    const sb = seatbeltProfile(sandboxPlan(policy, "workspace-write"));
    const lines = sb.split("\n");
    const allowAt = lines.findIndex((l) => l.includes('(subpath "/w")'));
    const protectAt = lines.findIndex((l) => l.includes('(subpath "/w/.teh")'));
    expect(lines).toContain("(deny file-write*)");
    expect(allowAt).toBeGreaterThan(0);
    expect(protectAt).toBeGreaterThan(allowAt);
    expect(sb).not.toContain("(deny network*)");
    expect(seatbeltProfile(sandboxPlan(policy, "read-only"))).toContain("(deny network*)");
    expect(seatbeltProfile({ writable: ['/a "b'], protect: [], hide: [], network: true })).toContain('"/a \\"b"');
  });

  test("bubblewrap mounts the system read-only and cuts the network", () => {
    const args = bubblewrapArgs({ writable: ["/"], protect: [], hide: [], network: false }, "/");
    expect(args.slice(0, 3)).toEqual(["--ro-bind", "/", "/"]);
    expect(args).toContain("--unshare-net");
    expect(args.slice(-2)).toEqual(["--chdir", "/"]);
  });
});

// Real isolation, on machines with a working sandbox. The folders live inside the repo,
// because the temp folder is writable at every level.
const base = realpathSync(join(import.meta.dir, "..", "..", ".."));
const box = mkdtempSync(join(base, ".sbx-"));
afterAll(() => rmSync(box, { recursive: true, force: true }));
const ws = join(box, "ws");
const outside = join(box, "outside");
const secret = join(box, "secret");
for (const d of [ws, outside, secret]) mkdirSync(d, { recursive: true });
writeFileSync(join(secret, "key"), "s3cret");
const found = detectSandbox({ workspaceRoots: [ws], network: true, denyRead: [secret] });
const sandbox = "sandbox" in found ? found.sandbox : undefined;

async function sh(command: string, level: SandboxLevel) {
  const ctx = { ...toolContext(ws), ...(sandbox ? { sandbox } : {}), sandboxLevel: level };
  return bashTool.run({ command, timeoutMs: 20_000 }, ctx);
}

describe.skipIf(!sandbox)(`OS sandbox (${sandbox?.kind ?? "unavailable"})`, () => {
  test("allowed commands write inside the workspace, not outside it", async () => {
    const ok = await sh("echo hi > inside.txt && cat inside.txt", "workspace-write");
    expect(ok).toMatchObject({ isError: false, content: expect.stringContaining("hi") });
    const out = await sh(`echo x > ${outside}/escape.txt`, "workspace-write");
    expect(out.isError).toBe(true);
    expect(out.content).toContain("[sandbox: this command ran workspace-write");
    expect(existsSync(join(outside, "escape.txt"))).toBe(false);
  });

  test("teh's settings and git hooks stay read-only inside the workspace", async () => {
    mkdirSync(join(ws, ".teh"), { recursive: true });
    mkdirSync(join(ws, ".git", "hooks"), { recursive: true });
    for (const target of [".teh/settings.json", ".git/hooks/pre-commit"]) {
      const r = await sh(`echo x > ${target}`, "workspace-write");
      expect(r.isError).toBe(true);
      expect(existsSync(join(ws, target))).toBe(false);
    }
  });

  test("read-only commands cannot write even inside the workspace", async () => {
    const r = await sh("echo x > ro.txt", "read-only");
    expect(r.isError).toBe(true);
    expect(existsSync(join(ws, "ro.txt"))).toBe(false);
    expect((await sh("ls && echo listed", "read-only")).content).toContain("listed");
  });

  test("paths from Read deny rules are hidden", async () => {
    const r = await sh(`cat ${secret}/key`, "workspace-write");
    expect(r.content).not.toContain("s3cret");
  });

  test("read-only commands have no network; allowed ones do", async () => {
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("pong") });
    try {
      const probe = `exec 3<>/dev/tcp/127.0.0.1/${server.port} && echo connected`;
      expect((await sh(probe, "read-only")).content).not.toContain("connected");
      expect((await sh(probe, "workspace-write")).content).toContain("connected");
    } finally {
      server.stop(true);
    }
  });
});
