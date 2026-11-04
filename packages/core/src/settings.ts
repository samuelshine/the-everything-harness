// Permission rules from settings files, and workspace trust (ADR-0003, ADR-0010).
// Files use Claude Code's shape: { "permissions": { "allow": [], "ask": [], "deny": [] } }.
// Project allow rules apply only once the user trusts the folder; deny and ask rules
// apply at once, since they can only make teh more careful.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseRules, type Rule } from "./permissions";

export type SettingsScope = "user" | "project";

export type RuleSet = { allow: Rule[]; ask: Rule[]; deny: Rule[] };

export type LoadedSettings = {
  user: RuleSet;
  project: RuleSet;
  // Files that were read, and problems with ones that could not be.
  files: { path: string; scope: SettingsScope }[];
  problems: { path: string; message: string }[];
};

export function settingsFiles(tehHome: string, projectRoot: string, home = homedir()) {
  return [
    { scope: "user" as const, path: join(tehHome, "settings.json") },
    { scope: "user" as const, path: join(home, ".claude", "settings.json") },
    { scope: "project" as const, path: join(projectRoot, ".teh", "settings.json") },
    { scope: "project" as const, path: join(projectRoot, ".teh", "settings.local.json") },
    { scope: "project" as const, path: join(projectRoot, ".claude", "settings.json") },
    { scope: "project" as const, path: join(projectRoot, ".claude", "settings.local.json") },
  ];
}

const empty = (): RuleSet => ({ allow: [], ask: [], deny: [] });

export function loadSettings(tehHome: string, projectRoot: string, home = homedir()): LoadedSettings {
  const out: LoadedSettings = { user: empty(), project: empty(), files: [], problems: [] };
  const seen = new Set<string>();
  for (const f of settingsFiles(tehHome, projectRoot, home)) {
    const path = resolve(f.path);
    // When the project is the home folder, ~/.claude/settings.json is a user file only.
    if (seen.has(path) || !existsSync(path)) continue;
    seen.add(path);
    let data: unknown;
    try {
      data = JSON.parse(readFileSync(path, "utf8"));
    } catch (e) {
      out.problems.push({ path, message: `not valid JSON: ${(e as Error).message}` });
      continue;
    }
    out.files.push({ path, scope: f.scope });
    const perms = (data as { permissions?: Record<string, unknown> })?.permissions;
    if (!perms || typeof perms !== "object") continue;
    for (const kind of ["allow", "ask", "deny"] as const) {
      const list = perms[kind];
      if (list === undefined) continue;
      if (!Array.isArray(list) || list.some((r) => typeof r !== "string")) {
        out.problems.push({ path, message: `permissions.${kind} must be a list of strings` });
        continue;
      }
      out[f.scope][kind].push(...parseRules(list as string[], path));
    }
  }
  return out;
}

// --- Trust -----------------------------------------------------------------------------

function trustFile(tehHome: string) {
  return join(tehHome, "trusted-projects.json");
}

function readTrusted(tehHome: string): string[] {
  try {
    const data = JSON.parse(readFileSync(trustFile(tehHome), "utf8")) as { projects?: unknown };
    return Array.isArray(data.projects) ? data.projects.filter((p): p is string => typeof p === "string") : [];
  } catch {
    return [];
  }
}

export function isTrusted(tehHome: string, projectRoot: string): boolean {
  return readTrusted(tehHome).includes(resolve(projectRoot));
}

export function setTrusted(tehHome: string, projectRoot: string, trusted: boolean): void {
  const root = resolve(projectRoot);
  const list = readTrusted(tehHome).filter((p) => p !== root);
  if (trusted) list.push(root);
  mkdirSync(tehHome, { recursive: true, mode: 0o700 });
  writeFileSync(trustFile(tehHome), `${JSON.stringify({ projects: list.sort() }, null, 2)}\n`, { mode: 0o600 });
}
