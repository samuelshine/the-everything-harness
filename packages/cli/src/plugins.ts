// `teh plugin install|list|enable|disable|remove` (ADR-0026).
import {
  commitPlugin,
  installedPlugins,
  PluginError,
  type PluginSummary,
  preparePlugin,
  removePlugin,
  setPluginEnabled,
  tehHome,
} from "@everything-harness/core";
import type { Io } from "./cli";

const USAGE =
  "teh: usage: teh plugin install <dir | git-url | name@marketplace> [--yes] | list | enable <name> | disable <name> | remove <name>\n";

export async function pluginCommand(io: Io, args: string[], yes: boolean): Promise<number> {
  const [verb, arg] = args;
  const home = tehHome(io.env);
  if (verb === "list" || verb === undefined) return list(io, home);
  if (verb === "install") {
    if (!arg) {
      io.err(USAGE);
      return 2;
    }
    return install(io, home, arg, yes);
  }
  if (verb === "enable" || verb === "disable" || verb === "remove") {
    if (!arg) {
      io.err(USAGE);
      return 2;
    }
    const done = verb === "remove" ? removePlugin(home, arg) : setPluginEnabled(home, arg, verb === "enable");
    if (!done) {
      io.err(`teh: no installed plugin named ${arg}; \`teh plugin list\` lists them\n`);
      return 1;
    }
    io.out(
      verb === "remove"
        ? `Removed ${arg}.\n`
        : `${verb === "enable" ? "Enabled" : "Disabled"} ${arg}${verb === "enable" ? "" : "; its files stay, `teh plugin enable` brings it back"}.\n`,
    );
    return 0;
  }
  io.err(USAGE);
  return 2;
}

function counts(s: PluginSummary): string {
  const hooks = s.hooks.length;
  return [
    s.commands.length ? `${s.commands.length} command(s)` : "",
    s.skills.length ? `${s.skills.length} skill(s)` : "",
    s.agents.length ? `${s.agents.length} agent(s)` : "",
    hooks ? `${hooks} hook(s)` : "",
    s.mcpServers.length ? `${s.mcpServers.length} MCP server(s)` : "",
  ]
    .filter(Boolean)
    .join(", ");
}

function printSummary(
  io: Io,
  name: string,
  version: string | undefined,
  description: string | undefined,
  s: PluginSummary,
) {
  io.out(`Plugin ${name}${version ? ` ${version}` : ""}${description ? `: ${description}` : ""}\n`);
  const list = (label: string, items: string[]) =>
    items.length && io.out(`  ${label.padEnd(12)} ${items.join(", ")}\n`);
  list(
    "commands",
    s.commands.map((c) => `/${c}`),
  );
  list("skills", s.skills);
  list(
    "agents",
    s.agents.map((a) => `${a} (kept; used from a later release)`),
  );
  for (const h of s.hooks) io.out(`  hook         ${h.event.padEnd(20)} ${h.what}\n`);
  for (const m of s.mcpServers) io.out(`  MCP server   ${m.name.padEnd(20)} ${m.what}\n`);
  if (!counts(s)) io.out("  (nothing that teh loads)\n");
  for (const p of s.problems) io.out(`  problem      ${p}\n`);
}

async function install(io: Io, home: string, spec: string, yes: boolean): Promise<number> {
  let prepared: Awaited<ReturnType<typeof preparePlugin>>;
  try {
    prepared = await preparePlugin(spec, { tehHome: home, cwd: io.cwd, env: io.env });
  } catch (e) {
    if (!(e instanceof PluginError)) throw e;
    io.err(`teh: cannot install ${spec}: ${e.message}\n`);
    return 1;
  }
  const { manifest, summary } = prepared;
  printSummary(io, manifest.name, manifest.version, manifest.description, summary);
  io.out(
    "A plugin is code: its hooks and MCP servers run on your machine with your rights, without asking, like your own.\n",
  );
  const ok = yes || (io.confirm ? await io.confirm(`Install ${manifest.name}?`) : false);
  if (!ok) {
    prepared.discard();
    if (io.confirm && !yes) io.err("Not installed.\n");
    else io.err(`teh: nothing installed: there is no terminal to ask on; review the above, then pass --yes\n`);
    return io.confirm && !yes ? 1 : 2;
  }
  const { replaced } = commitPlugin(prepared, home);
  io.out(
    `${replaced ? "Updated" : "Installed"} ${manifest.name} in ${home}/plugins/${manifest.name}. \`teh plugin list\` shows it.\n`,
  );
  return 0;
}

function list(io: Io, home: string): number {
  const { plugins, problem } = installedPlugins(home);
  if (!plugins.length) {
    io.out("No plugins installed. Install one with `teh plugin install <dir | git-url | name@marketplace>`.\n");
  }
  for (const p of plugins) {
    const parts = p.parts;
    const what = parts
      ? [
          parts.commandFiles.length ? `${parts.commandFiles.length} command(s)` : "",
          parts.skillFiles.length ? `${parts.skillFiles.length} skill(s)` : "",
          parts.agentFiles.length ? `${parts.agentFiles.length} agent(s)` : "",
          parts.hookSources.length ? "hooks" : "",
          parts.mcpSources.length ? "MCP servers" : "",
        ]
          .filter(Boolean)
          .join(", ")
      : "";
    io.out(
      `  ${p.name.padEnd(24)} ${(p.manifest?.version ?? "").padEnd(8)} ${(p.enabled ? "enabled" : "disabled").padEnd(9)} ${what}\n`,
    );
    io.out(`    from ${p.entry.source}\n`);
    for (const m of p.problems) io.out(`    problem: ${m}\n`);
  }
  if (problem) io.err(`teh: warning: ${problem}\n`);
  return 0;
}
