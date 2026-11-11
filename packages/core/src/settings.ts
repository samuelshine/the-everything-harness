// Permission rules from settings files, and workspace trust (ADR-0003, ADR-0010).
// Files use Claude Code's shape: { "permissions": { "allow": [], "ask": [], "deny": [] } }.
// Project allow rules apply only once the user trusts the folder; deny and ask rules
// apply at once, since they can only make teh more careful.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { type HookConfig, mergeHooks, parseHooks } from "./hooks";
import { PERMISSION_MODES, type PermissionMode, parseRules, type Rule } from "./permissions";

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
  // "cleanupPeriodDays" (ADR-0004, Claude Code's name): days to keep sessions nobody has
  // touched. "checkpointRetentionDays": days to keep undo checkpoints; unset keeps them.
  // User settings only, like cacheRetentionDays.
  cleanupPeriodDays?: number;
  checkpointRetentionDays?: number;
  // "screen": "fullscreen" or "inline" (ADR-0018). User settings only.
  screen?: "fullscreen" | "inline";
  // "model": the model to use when none is given on the command line (ADR-0014). The
  // project's wins over the user's. "roles": {"explore": model} for explore subagents.
  model: { user?: string; project?: string };
  exploreModel: { user?: string; project?: string };
  // "permissions.defaultMode": the permission mode to start in. The project's wins.
  defaultMode: { user?: PermissionMode; project?: PermissionMode };
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
    model: {},
    exploreModel: {},
    defaultMode: {},
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
    const d = (data ?? {}) as Record<string, unknown>;
    for (const key of ["cleanupPeriodDays", "checkpointRetentionDays"] as const) {
      const n = d[key];
      if (n === undefined || f.scope !== "user") continue;
      if (typeof n === "number" && n >= 1) out[key] = n;
      else out.problems.push({ path, message: `${key} must be a number of days (1 or more)` });
    }
    if (d.screen !== undefined && f.scope === "user") {
      if (d.screen === "fullscreen" || d.screen === "inline") out.screen = d.screen;
      else out.problems.push({ path, message: 'screen must be "fullscreen" or "inline"' });
    }
    if (typeof d.model === "string" && d.model.trim()) out.model[f.scope] = d.model.trim();
    else if (d.model !== undefined) out.problems.push({ path, message: "model must be provider:model" });
    const roles = d.roles as { explore?: unknown } | undefined;
    if (typeof roles?.explore === "string" && roles.explore.trim()) out.exploreModel[f.scope] = roles.explore.trim();
    else if (roles?.explore !== undefined) out.problems.push({ path, message: "roles.explore must be provider:model" });
    const dm = (d.permissions as { defaultMode?: unknown } | undefined)?.defaultMode;
    if (typeof dm === "string" && (PERMISSION_MODES as string[]).includes(dm))
      out.defaultMode[f.scope] = dm as PermissionMode;
    else if (dm !== undefined)
      out.problems.push({ path, message: `permissions.defaultMode must be one of ${PERMISSION_MODES.join(", ")}` });
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

// Set one key in a settings file, keeping everything else in it. `key` may be a dotted path
// ("permissions.defaultMode"); `undefined` removes it. Returns false, changing nothing, when
// the file exists but is not a JSON object.
export function setSetting(path: string, key: string, value: unknown): boolean {
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
  const parts = key.split(".");
  let at = data;
  for (const part of parts.slice(0, -1)) {
    const next = at[part];
    if (typeof next !== "object" || next === null || Array.isArray(next)) at[part] = {};
    at = at[part] as Record<string, unknown>;
  }
  const last = parts[parts.length - 1] as string;
  if (value === undefined) delete at[last];
  else at[last] = value;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  return true;
}

// The person's own settings file.
export function setUserSetting(tehHome: string, key: string, value: unknown): boolean {
  return setSetting(join(tehHome, "settings.json"), key, value);
}

// This project's personal settings, .teh/settings.local.json, kept out of git like Claude
// Code's settings.local.json.
export function setProjectSetting(projectRoot: string, key: string, value: unknown): boolean {
  const dir = join(projectRoot, ".teh");
  const ignore = join(dir, ".gitignore");
  mkdirSync(dir, { recursive: true });
  if (!existsSync(ignore)) writeFileSync(ignore, "settings.local.json\n");
  return setSetting(join(dir, "settings.local.json"), key, value);
}
