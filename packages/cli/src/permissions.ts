// Permission rules for a run, and the trust and permissions commands (ADR-0003).
import { relative } from "node:path";
import {
  findProjectRoot,
  formatRule,
  isTrusted,
  loadSettings,
  type PermissionConfig,
  type PermissionMode,
  parseRules,
  type Rule,
  type Skill,
  setTrusted,
  tehHome,
} from "@everything-harness/core";
import type { Io } from "./cli";

export type RunPermissions = {
  config: PermissionConfig;
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

  return {
    config: {
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
    },
    skills,
    warnings,
  };
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

export function printPermissions(io: Io, skills: Skill[], home: string): number {
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
  io.out(
    "\nAlways allowed: reading inside the project, and read-only commands such as ls, cat, grep, git status/log/diff.\n" +
      "Always asks (outside bypassPermissions): writes inside .git, .teh, .claude and .agents.\n",
  );
  for (const p of settings.problems) io.err(`teh: warning: ignored ${p.path}: ${p.message}\n`);
  return 0;
}
