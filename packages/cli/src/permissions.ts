// Permission rules for a run, and the trust and permissions commands (ADR-0003).
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  detectSandbox,
  findProjectRoot,
  formatRule,
  isTrusted,
  loadSettings,
  type PermissionConfig,
  type PermissionMode,
  parseRules,
  type Rule,
  type Sandbox,
  type Skill,
  setTrusted,
  tehHome,
} from "@everything-harness/core";
import type { Io } from "./cli";

export const SANDBOX_MODES = ["auto", "on", "off"] as const;
export type SandboxMode = (typeof SANDBOX_MODES)[number];

export type RunPermissions = {
  config: PermissionConfig;
  sandbox?: Sandbox;
  // Set when --sandbox on (or settings) asked for a sandbox that cannot run here.
  sandboxError?: string;
  // Skills with project-level allowed-tools removed when the folder is untrusted.
  skills: Skill[];
  warnings: string[];
};

const rel = (root: string, p: string) => {
  const r = relative(root, p);
  return r.startsWith("..") ? p : r;
};

export function runPermissions(
  io: Io,
  opts: {
    mode: PermissionMode;
    allowed: string[];
    disallowed: string[];
    skills: Skill[];
    home: string;
    sandbox?: SandboxMode;
    addDirs?: string[];
  },
): RunPermissions {
  const root = findProjectRoot(io.cwd);
  const teh = tehHome(io.env);
  const settings = loadSettings(teh, root, opts.home);
  const trusted = isTrusted(teh, root);
  const warnings = settings.problems.map((p) => `ignored ${p.path}: ${p.message}`);

  const ignoredAllow = trusted ? [] : settings.project.allow;
  const ignoredSkills = trusted ? [] : opts.skills.filter((s) => s.source === "project" && s.allowedTools?.length);
  if (ignoredAllow.length || ignoredSkills.length) {
    const what = [
      ignoredAllow.length ? `${ignoredAllow.length} allow rule(s) in project settings` : "",
      ignoredSkills.length ? `allowed-tools of project skill(s) ${ignoredSkills.map((s) => s.name).join(", ")}` : "",
    ]
      .filter(Boolean)
      .join(" and ");
    warnings.push(`ignoring ${what} until you trust this folder: run \`teh trust\` after reviewing them`);
  }
  const skills = trusted
    ? opts.skills
    : opts.skills.map((s) => {
        if (s.source !== "project" || !s.allowedTools) return s;
        const { allowedTools: _, ...rest } = s;
        return rest;
      });

  const config: PermissionConfig = {
    mode: opts.mode,
    allow: [
      ...parseRules(opts.allowed, "--allowedTools"),
      ...settings.user.allow,
      ...(trusted ? settings.project.allow : []),
    ],
    ask: [...settings.user.ask, ...settings.project.ask],
    deny: [...parseRules(opts.disallowed, "--disallowedTools"), ...settings.user.deny, ...settings.project.deny],
    projectRoot: root,
    home: opts.home,
  };

  // Sandbox settings: an untrusted project may only make the sandbox stricter.
  const sbUser = settings.sandbox.user;
  const sbProject = settings.sandbox.project;
  const projectEnabled = trusted ? sbProject.enabled : sbProject.enabled === "on" ? "on" : undefined;
  const enabled: SandboxMode = opts.sandbox ?? projectEnabled ?? sbUser.enabled ?? "auto";
  const network = trusted
    ? (sbProject.network ?? sbUser.network ?? true)
    : sbProject.network === false
      ? false
      : (sbUser.network ?? true);
  const allowWrite = [...(sbUser.allowWrite ?? []), ...(trusted ? (sbProject.allowWrite ?? []) : [])];
  let sandbox: Sandbox | undefined;
  let sandboxError: string | undefined;
  if (enabled !== "off") {
    const found = detectSandbox({
      workspaceRoots: [root, io.cwd, ...(opts.addDirs ?? []).map((d) => resolve(io.cwd, d))],
      allowWrite,
      network,
      denyRead: config.deny.flatMap((r) =>
        r.tool === "Read" && r.pattern ? literalPath(r.pattern, root, opts.home) : [],
      ),
      home: opts.home,
    });
    if ("sandbox" in found) sandbox = found.sandbox;
    else if (enabled === "on") sandboxError = `no sandbox available: ${found.unavailable}`;
    else if (process.platform !== "win32") {
      warnings.push(`shell commands run without a sandbox: ${found.unavailable}`);
    }
  }

  return {
    ...(sandbox ? { sandbox } : {}),
    ...(sandboxError ? { sandboxError } : {}),
    config,
    skills,
    warnings,
  };
}

// A Read rule's path when it has no wildcards, so the sandbox can hide it too.
function literalPath(pattern: string, root: string, home: string): string[] {
  if (/[*?[\]{}]/.test(pattern)) return [];
  const p = pattern.trim();
  if (p.startsWith("//")) return [p.slice(1)];
  if (p.startsWith("~/")) return [join(home, p.slice(2))];
  return [isAbsolute(p) ? join(root, p) : resolve(root, p)];
}

export function trust(io: Io, revoke: boolean, home: string): number {
  const root = findProjectRoot(io.cwd);
  const teh = tehHome(io.env);
  if (revoke) {
    setTrusted(teh, root, false);
    io.out(`No longer trusting ${root}. Its allow rules and skill grants are ignored again.\n`);
    return 0;
  }
  if (root === home) {
    io.err("teh: refusing to trust your home folder; run teh trust inside a project\n");
    return 2;
  }
  const settings = loadSettings(teh, root, home);
  setTrusted(teh, root, true);
  io.out(`Trusted ${root}.\n`);
  const allow = settings.project.allow;
  if (allow.length) {
    io.out("These project allow rules now apply:\n");
    for (const r of allow) io.out(`  ${formatRule(r).padEnd(36)} ${rel(root, r.source ?? "")}\n`);
  } else io.out("It has no allow rules yet; project skills' allowed-tools now apply too.\n");
  io.out("Undo with `teh trust --revoke`.\n");
  return 0;
}

export function printPermissions(io: Io, skills: Skill[], home: string, sandboxMode?: SandboxMode): number {
  const root = findProjectRoot(io.cwd);
  const teh = tehHome(io.env);
  const settings = loadSettings(teh, root, home);
  const trusted = isTrusted(teh, root);
  const show = (title: string, rules: Rule[], note = "") => {
    io.out(`${title}${note}\n`);
    if (rules.length === 0) io.out("  (none)\n");
    for (const r of rules) io.out(`  ${formatRule(r).padEnd(36)} ${rel(root, r.source ?? "")}\n`);
  };
  io.out(`Project ${root}: ${trusted ? "trusted" : "not trusted (`teh trust` to trust it)"}\n\n`);
  show("Deny (always blocked):", [...settings.user.deny, ...settings.project.deny]);
  show("Ask (always asks first):", [...settings.user.ask, ...settings.project.ask]);
  show("Allow (runs without asking):", settings.user.allow);
  if (settings.project.allow.length)
    show("Project allow rules", settings.project.allow, trusted ? ":" : " (ignored until trusted):");
  const grants = skills.filter((s) => s.allowedTools?.length);
  if (grants.length) {
    io.out("Skill grants (while the skill is loaded):\n");
    for (const s of grants) {
      const off = s.source === "project" && !trusted ? "  (ignored until trusted)" : "";
      io.out(`  /${s.name}: ${(s.allowedTools ?? []).join(", ")}${off}\n`);
    }
  }
  const run = runPermissions(io, {
    mode: "default",
    allowed: [],
    disallowed: [],
    skills,
    home,
    ...(sandboxMode ? { sandbox: sandboxMode } : {}),
  });
  io.out("\nSandbox for shell commands:\n");
  if (run.sandbox) {
    io.out(`  ${run.sandbox.kind}\n`);
    io.out(`  commands that ran without asking: ${run.sandbox.describe("read-only")}\n`);
    io.out(`  commands you or a rule allowed: ${run.sandbox.describe("workspace-write")}\n`);
  } else
    io.out(`  none${run.sandboxError ? ` (${run.sandboxError})` : ""}; allowed commands can do anything you can\n`);
  io.out(
    "\nAlways allowed: reading inside the project, and read-only commands such as ls, cat, grep, git status/log/diff.\n" +
      "Always asks (outside bypassPermissions): writes inside .git, .teh, .claude and .agents.\n",
  );
  for (const p of settings.problems) io.err(`teh: warning: ignored ${p.path}: ${p.message}\n`);
  return 0;
}
