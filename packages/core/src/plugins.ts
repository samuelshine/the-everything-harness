// Plugins (ADR-0026): Claude Code's plugin layout, installed into teh's own home.
//   <plugin>/.claude-plugin/plugin.json      manifest ("name" is required)
//   <plugin>/commands/*.md  agents/*.md  skills/<name>/SKILL.md  hooks/hooks.json  .mcp.json
// Installed copies live in <tehHome>/plugins/<name>/, recorded in <tehHome>/plugins/installed.json.
// Nothing here reads a terminal or process globals: the environment is passed in.
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";
import { type HookConfig, type HookGroup, hookName, mergeHooks, parseHooks } from "./hooks";
import { type McpServerConfig, parseMcpServers } from "./mcp/config";

export class PluginError extends Error {}

const NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const PLUGIN_ROOT_VARS = ["CLAUDE_PLUGIN_ROOT", "TEH_PLUGIN_ROOT"] as const;

// --- Manifest ---------------------------------------------------------------------------

export type PluginManifest = {
  name: string;
  version?: string;
  description?: string;
  author?: string;
  // Extra locations on top of the default folders, relative to the plugin.
  commands: string[];
  agents: string[];
  skills: string[];
  // A path to a hooks file, or the hooks themselves.
  hooks: (string | Record<string, unknown>)[];
  mcpServers: (string | Record<string, unknown>)[];
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function parsePluginManifest(raw: unknown): { manifest?: PluginManifest; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw)) return { problems: ["plugin.json must be a JSON object"] };
  if (typeof raw.name !== "string" || !raw.name) return { problems: ['plugin.json needs a "name"'] };
  if (!NAME.test(raw.name))
    return { problems: [`name "${raw.name}" must be lowercase letters, digits and hyphens (max 64)`] };
  const paths = (field: string): string[] => {
    const v = raw[field];
    if (v === undefined) return [];
    const list = Array.isArray(v) ? v : [v];
    if (list.some((p) => typeof p !== "string" || !p)) {
      problems.push(`"${field}" must be a path, or a list of paths, relative to the plugin`);
      return [];
    }
    return list.filter((p) => {
      if (isAbsolute(p) || p.split(/[\\/]/).includes("..")) {
        problems.push(`"${field}": ${p} must stay inside the plugin`);
        return false;
      }
      return true;
    });
  };
  const pathsOrInline = (field: string): (string | Record<string, unknown>)[] => {
    const v = raw[field];
    if (v === undefined) return [];
    if (isObject(v)) return [v];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return paths(field);
    if (typeof v === "string") return paths(field);
    problems.push(`"${field}" must be a path, a list of paths, or an object`);
    return [];
  };
  const author = isObject(raw.author) ? raw.author.name : raw.author;
  const optional = (k: string, v: unknown) => (typeof v === "string" && v ? { [k]: v } : {});
  return {
    manifest: {
      name: raw.name,
      ...optional("version", raw.version),
      ...optional("description", raw.description),
      ...optional("author", author),
      commands: paths("commands"),
      agents: paths("agents"),
      skills: paths("skills"),
      hooks: pathsOrInline("hooks"),
      mcpServers: pathsOrInline("mcpServers"),
    },
    problems,
  };
}

export const manifestPath = (root: string) => join(root, ".claude-plugin", "plugin.json");

export function readPluginManifest(root: string): { manifest?: PluginManifest; problems: string[] } {
  const file = manifestPath(root);
  if (!existsSync(file)) return { problems: ["no .claude-plugin/plugin.json: this is not a plugin"] };
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { problems: [`plugin.json is not valid JSON: ${(e as Error).message}`] };
  }
  return parsePluginManifest(raw);
}

function inside(root: string, path: string): boolean {
  const base = resolve(root);
  const p = resolve(path);
  return p === base || p.startsWith(base + sep);
}

// --- What a plugin contains ---------------------------------------------------------------

export type PluginParts = {
  commandFiles: string[];
  skillFiles: string[];
  agentFiles: string[];
  hookSources: { path: string; raw: unknown }[];
  mcpSources: { path: string; raw: unknown }[];
  problems: { area: "hooks" | "mcp"; path: string; message: string }[];
};

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
};

function markdownIn(path: string): string[] {
  if (path.endsWith(".md") && existsSync(path)) return [path];
  if (!isDir(path)) return [];
  return readdirSync(path)
    .filter((n) => n.endsWith(".md"))
    .sort()
    .map((n) => join(path, n));
}

function skillFilesIn(path: string): string[] {
  if (existsSync(join(path, "SKILL.md"))) return [join(path, "SKILL.md")];
  if (!isDir(path)) return [];
  return readdirSync(path)
    .sort()
    .map((n) => join(path, n, "SKILL.md"))
    .filter((f) => existsSync(f));
}

const unique = (xs: string[]) => [...new Set(xs)];

export function pluginParts(root: string, manifest: PluginManifest): PluginParts {
  const at = (p: string) => resolve(root, p);
  const parts: PluginParts = {
    commandFiles: unique([join(root, "commands"), ...manifest.commands.map(at)].flatMap(markdownIn)),
    skillFiles: unique([join(root, "skills"), ...manifest.skills.map(at)].flatMap(skillFilesIn)),
    agentFiles: unique([join(root, "agents"), ...manifest.agents.map(at)].flatMap(markdownIn)),
    hookSources: [],
    mcpSources: [],
    problems: [],
  };
  const readJson = (area: "hooks" | "mcp", path: string, into: { path: string; raw: unknown }[]) => {
    try {
      into.push({ path, raw: JSON.parse(readFileSync(path, "utf8")) });
    } catch (e) {
      parts.problems.push({ area, path, message: `not valid JSON: ${(e as Error).message}` });
    }
  };
  const files = (area: "hooks" | "mcp", defaults: string, listed: (string | Record<string, unknown>)[]) => {
    const into = area === "hooks" ? parts.hookSources : parts.mcpSources;
    const seen = new Set<string>();
    for (const item of [defaults, ...listed]) {
      if (typeof item === "string") {
        const path = at(item);
        if (!seen.has(path) && existsSync(path)) readJson(area, path, into);
        seen.add(path);
      } else into.push({ path: manifestPath(root), raw: item });
    }
  };
  files("hooks", join("hooks", "hooks.json"), manifest.hooks);
  files("mcp", ".mcp.json", manifest.mcpServers);
  return parts;
}

// hooks.json may be {"hooks": {...}} (Claude Code's plugin files) or the bare event map.
function hooksOf(raw: unknown): unknown {
  return isObject(raw) && "hooks" in raw ? raw.hooks : raw;
}

// .mcp.json may be {"mcpServers": {...}} or the bare server map.
function serversOf(raw: unknown): unknown {
  return isObject(raw) && "mcpServers" in raw ? raw : { mcpServers: raw };
}

// "${CLAUDE_PLUGIN_ROOT}" in a hook command becomes the plugin's folder; the folder is also
// exported to the command, so scripts can read $CLAUDE_PLUGIN_ROOT.
export function substitutePluginRoot(text: string, root: string): string {
  return text.replace(/\$\{(?:CLAUDE|TEH)_PLUGIN_ROOT\}/g, root);
}

export function bindHooksToPlugin(config: HookConfig, root: string): HookConfig {
  const env = Object.fromEntries(PLUGIN_ROOT_VARS.map((v) => [v, root]));
  const out: HookConfig = {};
  for (const [event, groups] of Object.entries(config) as [keyof HookConfig, HookGroup[]][])
    out[event] = groups.map((g) => ({
      ...g,
      hooks: g.hooks.map((h) =>
        h.type === "http" || h.type === "prompt"
          ? h
          : { ...h, command: substitutePluginRoot(h.command, root), env: { ...h.env, ...env } },
      ),
    }));
  return out;
}

// --- Registry -----------------------------------------------------------------------------

export type RegistryEntry = {
  // What was given to `teh plugin install`: an absolute path, a git URL, or name@marketplace.
  source: string;
  installedAt: string;
  enabled: boolean;
  marketplace?: string;
};

export const pluginsDir = (tehHome: string) => join(tehHome, "plugins");
const registryFile = (tehHome: string) => join(pluginsDir(tehHome), "installed.json");

export function readRegistry(tehHome: string): { plugins: Record<string, RegistryEntry>; problem?: string } {
  const file = registryFile(tehHome);
  if (!existsSync(file)) return { plugins: {} };
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as { plugins?: unknown };
    const plugins: Record<string, RegistryEntry> = {};
    if (isObject(data.plugins))
      for (const [name, v] of Object.entries(data.plugins)) {
        if (!NAME.test(name) || !isObject(v) || typeof v.source !== "string") continue;
        plugins[name] = {
          source: v.source,
          installedAt: typeof v.installedAt === "string" ? v.installedAt : "",
          enabled: v.enabled !== false,
          ...(typeof v.marketplace === "string" ? { marketplace: v.marketplace } : {}),
        };
      }
    return { plugins };
  } catch (e) {
    return { plugins: {}, problem: `${file}: not valid JSON: ${(e as Error).message}` };
  }
}

function writeRegistry(tehHome: string, plugins: Record<string, RegistryEntry>) {
  mkdirSync(pluginsDir(tehHome), { recursive: true });
  writeFileSync(registryFile(tehHome), `${JSON.stringify({ plugins }, null, 2)}\n`);
}

export function setPluginEnabled(tehHome: string, name: string, enabled: boolean): boolean {
  const { plugins } = readRegistry(tehHome);
  const entry = plugins[name];
  if (!entry) return false;
  plugins[name] = { ...entry, enabled };
  writeRegistry(tehHome, plugins);
  return true;
}

export function removePlugin(tehHome: string, name: string): boolean {
  const { plugins } = readRegistry(tehHome);
  if (!plugins[name]) return false;
  delete plugins[name];
  writeRegistry(tehHome, plugins);
  rmSync(join(pluginsDir(tehHome), name), { recursive: true, force: true });
  return true;
}

// "plugin <name>" when a file lives inside an installed plugin, for listings.
export function pluginLabel(tehHome: string, path: string): string | undefined {
  const base = pluginsDir(tehHome) + sep;
  if (!path.startsWith(base)) return undefined;
  const name = path.slice(base.length).split(sep)[0];
  return name ? `plugin ${name}` : undefined;
}

// --- Loading ------------------------------------------------------------------------------

export type LoadedPlugin = {
  name: string;
  root: string;
  enabled: boolean;
  entry: RegistryEntry;
  manifest?: PluginManifest;
  parts?: PluginParts;
  problems: string[];
};

// Every installed plugin, enabled or not, with its manifest and contents read.
export function installedPlugins(tehHome: string): { plugins: LoadedPlugin[]; problem?: string } {
  const reg = readRegistry(tehHome);
  const plugins = Object.entries(reg.plugins).map(([name, entry]): LoadedPlugin => {
    const root = join(pluginsDir(tehHome), name);
    const base = { name, root, enabled: entry.enabled, entry };
    if (!isDir(root)) return { ...base, problems: ["its folder is missing; reinstall or remove it"] };
    const m = readPluginManifest(root);
    if (!m.manifest) return { ...base, problems: m.problems };
    return { ...base, manifest: m.manifest, parts: pluginParts(root, m.manifest), problems: m.problems };
  });
  return { plugins, ...(reg.problem ? { problem: reg.problem } : {}) };
}

export type PluginSet = {
  plugins: LoadedPlugin[];
  hooks: HookConfig;
  mcpServers: McpServerConfig[];
  problems: { area: "manifest" | "hooks" | "mcp"; path: string; message: string }[];
};

// The enabled plugins' hooks and MCP servers, ready to merge at user level. Skills and commands
// are read by loadSkills from the same plugins. `env` expands ${VAR} in MCP server configs.
export function loadPlugins(tehHome: string, env: Record<string, string | undefined> = {}): PluginSet {
  const all = installedPlugins(tehHome);
  const out: PluginSet = { plugins: all.plugins.filter((p) => p.enabled), hooks: {}, mcpServers: [], problems: [] };
  if (all.problem) out.problems.push({ area: "manifest", path: pluginsDir(tehHome), message: all.problem });
  for (const p of out.plugins) {
    for (const message of p.problems) out.problems.push({ area: "manifest", path: p.root, message });
    if (!p.parts) continue;
    out.problems.push(...p.parts.problems);
    for (const src of p.parts.hookSources) {
      const h = parseHooks(hooksOf(src.raw), src.path);
      for (const message of h.problems) out.problems.push({ area: "hooks", path: src.path, message });
      out.hooks = mergeHooks(out.hooks, bindHooksToPlugin(h.config, p.root));
    }
    const vars = Object.fromEntries(PLUGIN_ROOT_VARS.map((v) => [v, p.root]));
    for (const src of p.parts.mcpSources) {
      const r = parseMcpServers(serversOf(src.raw), "user", src.path, { ...env, ...vars });
      for (const problem of r.problems) out.problems.push({ area: "mcp", ...problem });
      for (const s of r.servers) {
        out.mcpServers = out.mcpServers.filter((o) => o.name !== s.name);
        out.mcpServers.push(s.transport === "stdio" ? { ...s, env: { ...vars, ...s.env } } : s);
      }
    }
  }
  return out;
}

// --- Summary (shown before installing) --------------------------------------------------------

export type PluginSummary = {
  commands: string[];
  skills: string[];
  agents: string[];
  hooks: { event: string; what: string }[];
  mcpServers: { name: string; what: string }[];
  problems: string[];
};

export function summarizePlugin(root: string, manifest: PluginManifest): PluginSummary {
  const parts = pluginParts(root, manifest);
  const base = (f: string) => f.replace(/^.*[\\/]/, "").replace(/\.md$/, "");
  const out: PluginSummary = {
    commands: parts.commandFiles.map(base),
    skills: parts.skillFiles.map((f) => base(join(f, ".."))),
    agents: parts.agentFiles.map(base),
    hooks: [],
    mcpServers: [],
    problems: parts.problems.map((p) => `${p.path}: ${p.message}`),
  };
  for (const src of parts.hookSources) {
    const h = parseHooks(hooksOf(src.raw), src.path);
    out.problems.push(...h.problems.map((m) => `${src.path}: ${m}`));
    for (const [event, groups] of Object.entries(h.config))
      for (const g of groups ?? [])
        for (const hook of g.hooks)
          out.hooks.push({ event: g.matcher ? `${event}[${g.matcher}]` : event, what: hookName(hook) });
  }
  // The root is left unexpanded so the summary shows what the config says.
  const vars = Object.fromEntries(PLUGIN_ROOT_VARS.map((v) => [v, `\${${v}}`]));
  for (const src of parts.mcpSources) {
    const r = parseMcpServers(serversOf(src.raw), "user", src.path, vars);
    out.problems.push(...r.problems.map((p) => `${p.path}: ${p.message}`));
    for (const s of r.servers)
      out.mcpServers.push({
        name: s.name,
        what: s.transport === "stdio" ? [s.command, ...s.args].join(" ") : s.url,
      });
  }
  return out;
}

// --- Installing -------------------------------------------------------------------------------

export type GitRunner = (
  args: string[],
  env: Record<string, string | undefined>,
) => Promise<{ code: number; stderr: string }>;

const runGit: GitRunner = async (args, env) => {
  try {
    const p = Bun.spawn(["git", ...args], {
      env: { ...env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
    });
    const [stderr, code] = await Promise.all([new Response(p.stderr as ReadableStream).text(), p.exited]);
    return { code, stderr };
  } catch (e) {
    return { code: -1, stderr: `could not run git: ${(e as Error).message}` };
  }
};

export type PluginSource =
  | { kind: "dir"; path: string }
  | { kind: "git"; url: string }
  | { kind: "marketplace"; plugin: string; marketplace: PluginSource & { kind: "dir" | "git" } };

const GIT_URL = /^(?:https?:\/\/|ssh:\/\/|git:\/\/|file:\/\/|git@[^:\s]+:)/;

// A directory, a git URL, or name@marketplace (the marketplace is itself a directory or git URL).
export function classifySource(spec: string, cwd: string): PluginSource {
  const asLocation = (s: string): (PluginSource & { kind: "dir" | "git" }) | undefined =>
    isDir(resolve(cwd, s))
      ? { kind: "dir", path: resolve(cwd, s) }
      : GIT_URL.test(s)
        ? { kind: "git", url: s }
        : undefined;
  const direct = asLocation(spec);
  if (direct) return direct;
  const m = spec.match(/^([a-z0-9][a-z0-9-]*)@(.+)$/);
  const marketplace = m?.[2] ? asLocation(m[2]) : undefined;
  if (m?.[1] && marketplace) return { kind: "marketplace", plugin: m[1], marketplace };
  throw new PluginError(
    `${spec} is not a directory, a git URL, or <plugin>@<marketplace folder or git URL>${m ? ` (no such marketplace: ${m[2]})` : ""}`,
  );
}

export type InstallOptions = {
  tehHome: string;
  cwd: string;
  env: Record<string, string | undefined>;
  // For tests; the default runs `git`.
  git?: GitRunner;
};

export type PreparedPlugin = {
  name: string;
  manifest: PluginManifest;
  summary: PluginSummary;
  // The staging folder, moved into place by commitPlugin or removed by discard.
  root: string;
  source: string;
  marketplace?: string;
  discard(): void;
};

const describeSource = (s: PluginSource): string =>
  s.kind === "dir" ? s.path : s.kind === "git" ? s.url : `${s.plugin}@${describeSource(s.marketplace)}`;

function newStaging(tehHome: string): string {
  mkdirSync(pluginsDir(tehHome), { recursive: true });
  return mkdtempSync(join(pluginsDir(tehHome), ".staging-"));
}

// Puts the source's files in a fresh staging folder under the plugins directory (so the final
// move stays on one filesystem). The caller owns the folder.
async function stage(src: PluginSource & { kind: "dir" | "git" }, opts: InstallOptions): Promise<string> {
  const dest = newStaging(opts.tehHome);
  try {
    if (src.kind === "dir") {
      cpSync(src.path, dest, { recursive: true, filter: (p) => !/(^|[\\/])\.git$/.test(p) });
    } else {
      const r = await (opts.git ?? runGit)(["clone", "--depth", "1", "--quiet", "--", src.url, dest], opts.env);
      if (r.code !== 0) throw new PluginError(`git clone ${src.url} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
      rmSync(join(dest, ".git"), { recursive: true, force: true });
    }
    return dest;
  } catch (e) {
    rmSync(dest, { recursive: true, force: true });
    throw e;
  }
}

type MarketplaceEntry = { name: string; source: string | Record<string, unknown> };

export function parseMarketplace(raw: unknown): { plugins: MarketplaceEntry[]; problems: string[] } {
  const problems: string[] = [];
  if (!isObject(raw) || !Array.isArray(raw.plugins)) return { plugins: [], problems: ['expected {"plugins": [...]}'] };
  const plugins: MarketplaceEntry[] = [];
  for (const p of raw.plugins as unknown[]) {
    if (isObject(p) && typeof p.name === "string" && (typeof p.source === "string" || isObject(p.source)))
      plugins.push({ name: p.name, source: p.source });
    else problems.push('each plugin needs a "name" and a "source"');
  }
  return { plugins, problems };
}

// Where a marketplace entry's plugin lives, resolved against the marketplace.
function entrySource(entry: MarketplaceEntry, marketplaceRoot: string): PluginSource & { kind: "dir" | "git" } {
  const s = entry.source;
  if (typeof s === "string") {
    const path = resolve(marketplaceRoot, s);
    if (isAbsolute(s) || !inside(marketplaceRoot, path))
      throw new PluginError(`marketplace entry ${entry.name}: source ${s} must be a path inside the marketplace`);
    if (!isDir(path)) throw new PluginError(`marketplace entry ${entry.name}: ${s} is not a folder`);
    return { kind: "dir", path };
  }
  if (s.source === "github" && typeof s.repo === "string" && /^[\w.-]+\/[\w.-]+$/.test(s.repo))
    return { kind: "git", url: `https://github.com/${s.repo}.git` };
  if ((s.source === "url" || s.source === "git") && typeof s.url === "string" && GIT_URL.test(s.url))
    return { kind: "git", url: s.url };
  throw new PluginError(
    `marketplace entry ${entry.name}: source must be a "./path", {"source": "github", "repo"} or {"source": "url", "url"}`,
  );
}

// Fetches a plugin and reads it, without installing. Throws PluginError when it cannot be a plugin.
export async function preparePlugin(spec: string, opts: InstallOptions): Promise<PreparedPlugin> {
  const source = classifySource(spec, opts.cwd);
  let location: PluginSource & { kind: "dir" | "git" };
  let marketplaceCheckout: string | undefined;
  let marketplace: string | undefined;
  let wanted: string | undefined;
  if (source.kind === "marketplace") {
    wanted = source.plugin;
    marketplace = describeSource(source.marketplace);
    let root: string;
    if (source.marketplace.kind === "dir") root = source.marketplace.path;
    else root = marketplaceCheckout = await stage(source.marketplace, opts);
    try {
      const file = join(root, ".claude-plugin", "marketplace.json");
      if (!existsSync(file)) throw new PluginError(`${marketplace} has no .claude-plugin/marketplace.json`);
      let raw: unknown;
      try {
        raw = JSON.parse(readFileSync(file, "utf8"));
      } catch (e) {
        throw new PluginError(`${file} is not valid JSON: ${(e as Error).message}`);
      }
      const m = parseMarketplace(raw);
      const entry = m.plugins.find((p) => p.name === source.plugin);
      if (!entry)
        throw new PluginError(
          `${marketplace} has no plugin named ${source.plugin}${m.plugins.length ? `; it lists ${m.plugins.map((p) => p.name).join(", ")}` : ""}`,
        );
      // A local source is copied below, before a checkout it may live in is removed.
      location = entrySource(entry, root);
    } catch (e) {
      if (marketplaceCheckout) rmSync(marketplaceCheckout, { recursive: true, force: true });
      throw e;
    }
  } else location = source;
  let staged: string | undefined;
  try {
    staged = await stage(location, opts);
  } finally {
    if (marketplaceCheckout) rmSync(marketplaceCheckout, { recursive: true, force: true });
  }
  const discard = () => rmSync(staged, { recursive: true, force: true });
  const read = readPluginManifest(staged);
  if (!read.manifest) {
    discard();
    throw new PluginError(`${describeSource(source)}: ${read.problems.join("; ")}`);
  }
  if (wanted && read.manifest.name !== wanted) {
    discard();
    throw new PluginError(`marketplace lists ${wanted}, but its plugin.json is named ${read.manifest.name}`);
  }
  const summary = summarizePlugin(staged, read.manifest);
  summary.problems.unshift(...read.problems);
  return {
    name: read.manifest.name,
    manifest: read.manifest,
    summary,
    root: staged,
    source: describeSource(source),
    ...(marketplace ? { marketplace } : {}),
    discard,
  };
}

// Moves a prepared plugin into <tehHome>/plugins/<name> and records it. An earlier copy of the
// same name is replaced, so installing again updates.
export function commitPlugin(p: PreparedPlugin, tehHome: string): { replaced: boolean } {
  const dest = join(pluginsDir(tehHome), p.name);
  const { plugins } = readRegistry(tehHome);
  const replaced = !!plugins[p.name];
  rmSync(dest, { recursive: true, force: true });
  renameSync(p.root, dest);
  delete plugins[p.name];
  plugins[p.name] = {
    source: p.source,
    installedAt: new Date().toISOString(),
    enabled: true,
    ...(p.marketplace ? { marketplace: p.marketplace } : {}),
  };
  writeRegistry(tehHome, plugins);
  return { replaced };
}
