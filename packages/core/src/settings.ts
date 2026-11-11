// Permission rules from settings files, and workspace trust (ADR-0003, ADR-0010).
// Files use Claude Code's shape: { "permissions": { "allow": [], "ask": [], "deny": [] } }.
// Project allow rules apply only once the user trusts the folder; deny and ask rules
// apply at once, since they can only make teh more careful.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type HookConfig, mergeHooks, parseHooks } from "./hooks";
import { parseRules, type Rule } from "./permissions";

export type SettingsScope = "user" | "project";

export type RuleSet = { allow: Rule[]; ask: Rule[]; deny: Rule[] };

// The "sandbox" section: { "enabled": "auto" | "on" | "off", "network": bool, "allowWrite": [paths] }.
export type SandboxSettings = { enabled?: "auto" | "on" | "off"; network?: boolean; allowWrite?: string[] };

export type LoadedSettings = {
  user: RuleSet;
  project: RuleSet;
  sandbox: { user: SandboxSettings; project: SandboxSettings };
  // "outputStyle": a style name (ADR-0015). The project's wins over the user's, as in Claude Code.
  outputStyle: { user?: string; project?: string };
  // "cacheRetentionDays" (ADR-0018): days to keep each session's UI cache. User settings only,
  // since it is about the user's disk, not the project.
  cacheRetentionDays?: number;
  // "hooks" (ADR-0016). Project hooks run only once the folder is trusted.
  hooks: { user: HookConfig; project: HookConfig };
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
  const out: LoadedSettings = {
    user: empty(),
    project: empty(),
    sandbox: { user: {}, project: {} },
    outputStyle: {},
    hooks: { user: {}, project: {} },
    files: [],
    problems: [],
  };
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
    const hooks = parseHooks((data as { hooks?: unknown })?.hooks, path);
    out.hooks[f.scope] = mergeHooks(out.hooks[f.scope], hooks.config);
    for (const message of hooks.problems) out.problems.push({ path, message });
    const retention = (data as { cacheRetentionDays?: unknown })?.cacheRetentionDays;
    if (typeof retention === "number" && retention >= 0 && f.scope === "user") out.cacheRetentionDays = retention;
    else if (retention !== undefined && f.scope === "user")
      out.problems.push({ path, message: "cacheRetentionDays must be a number of days (0 or more)" });
    const style = (data as { outputStyle?: unknown })?.outputStyle;
    if (typeof style === "string" && style.trim()) out.outputStyle[f.scope] = style.trim();
    else if (style !== undefined) out.problems.push({ path, message: "outputStyle must be a style name" });
    const sb = (data as { sandbox?: Record<string, unknown> })?.sandbox;
    if (sb && typeof sb === "object") {
      const into = out.sandbox[f.scope];
      const enabled = sb.enabled === true ? "on" : sb.enabled === false ? "off" : sb.enabled;
      if (enabled === "auto" || enabled === "on" || enabled === "off") into.enabled = enabled;
      else if (enabled !== undefined)
        out.problems.push({ path, message: 'sandbox.enabled must be "auto", "on" or "off"' });
      if (typeof sb.network === "boolean") into.network = sb.network;
      else if (sb.network !== undefined) out.problems.push({ path, message: "sandbox.network must be true or false" });
      if (Array.isArray(sb.allowWrite) && sb.allowWrite.every((p) => typeof p === "string")) {
        const base = f.scope === "project" ? projectRoot : home;
        into.allowWrite = [
          ...(into.allowWrite ?? []),
          ...(sb.allowWrite as string[]).map((p) => (p.startsWith("~/") ? join(home, p.slice(2)) : resolve(base, p))),
        ];
      } else if (sb.allowWrite !== undefined) {
        out.problems.push({ path, message: "sandbox.allowWrite must be a list of paths" });
      }
    }
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

// Set one key in the person's own settings file, keeping everything else in it. Returns
// false, changing nothing, when the file exists but is not a JSON object.
export function setUserSetting(tehHome: string, key: string, value: unknown): boolean {
  const path = join(tehHome, "settings.json");
  let data: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      data = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
  }
  data[key] = value;
  mkdirSync(tehHome, { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return true;
}
