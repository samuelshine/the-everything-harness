# 0026 — Plugins

- **Status:** Accepted
- **Date:** 2026-11-25
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/06-plugins-mcp.md`, ADR-0003, ADR-0010, ADR-0015, ADR-0016, ADR-0017, ADR-0025

## Context
Skills, commands, hooks and MCP servers each load from their own files (ADR-0015, ADR-0016, ADR-0017). A plugin is how Claude Code bundles several of them so that one install adds a whole workflow, and a team can share it. ADR-0010 commits `teh` to Claude Code's formats, so a plugin written for Claude Code should install and work here.

Two things need deciding beyond copying the layout:
- **Trust.** A plugin is code: its hooks are shell commands and its MCP servers are programs, and neither runs in a sandbox. Unlike a cloned repo, a plugin is something the user went and fetched on purpose.
- **Where plugins live.** ADR-0009 and AGENTS.md rule out reading Claude Code's own folders, so teh keeps its own copies and its own record of what is installed.

## Options considered
1. **Own plugin format.** Simpler loader, but nobody's existing plugins would work and ADR-0010 would be broken.
2. **Read Claude Code's installed plugins in place.** No install step, but it reads `~/.claude/`, which ADR-0009 forbids, and ties teh to another program's state.
3. **Claude Code's layout, installed into teh's own home** (chosen).

## Decision
**Layout.** Claude Code's:
- `.claude-plugin/plugin.json` is the manifest. `name` is required (lower-case letters, digits and hyphens, at most 64). `version`, `description` and `author` are optional and shown only. Optional path fields `commands`, `agents`, `skills`, `hooks` and `mcpServers` add to the defaults; `hooks` and `mcpServers` may also be written inline.
- Defaults: `commands/*.md`, `agents/*.md`, `skills/<name>/SKILL.md`, `hooks/hooks.json` and `.mcp.json`. Manifest paths are relative to the plugin and may not leave it.
- Skills and commands are parsed by the ADR-0015 loader, hooks by the ADR-0016 parser (the file may be `{"hooks": {...}}` or the bare event map), and MCP servers by the ADR-0017 parser (`{"mcpServers": {...}}` or the bare server map). A bad file is reported and skipped; the rest of the plugin still loads.
- `agents/` is read and listed but not used until M5 (ADR-0007).

**Where it is kept.** `<tehHome>/plugins/<name>/` holds the copy, and `<tehHome>/plugins/installed.json` records, per name, the source, the install time, an optional marketplace and whether it is enabled. `teh plugin disable` keeps the files and stops loading them; `teh plugin remove` deletes both.

**Install sources.**
- A local directory, copied in.
- A git URL (`https://`, `ssh://`, `git://`, `file://`, `git@host:path`), fetched with `git clone --depth 1`; the `.git` folder is dropped.
- `name@marketplace`, where the marketplace is a local directory or a git URL holding `.claude-plugin/marketplace.json`: `{"name", "plugins": [{"name", "source", …}]}`. An entry's `source` is a path inside the marketplace (`"./plugins/fmt"`), `{"source": "github", "repo": "owner/repo"}` or `{"source": "url", "url": "…"}`. The installed copy is the plugin's own, so it does not need the marketplace afterwards.
- Reinstalling a name replaces the copy: that is how to update.

**Trust.** Installing is the act of trust, so it is explicit:
1. teh fetches the plugin into a staging folder and reads it.
2. It prints what the plugin contains: commands, skills, agents, hook events and commands, MCP servers and how they start.
3. It installs only on `--yes` or an interactive "yes". Without a terminal and without `--yes` it prints the contents and refuses.

After that, a plugin's hooks and MCP servers are **user level**: they run without `teh trust`, the same as ones in `~/.teh/`, with the user's full rights and no sandbox beyond what the server config asks for (ADR-0025). A plugin skill's `allowed-tools` apply for the same reason. A repository cannot install a plugin or switch one on. `teh plugin disable` is the quick way out.

**Plugin root.** `${CLAUDE_PLUGIN_ROOT}` and `${TEH_PLUGIN_ROOT}` are replaced by the plugin's folder in hook commands and in MCP server commands, arguments, environment, URLs and headers. Both are also exported to hook commands and stdio servers, so scripts can read `$CLAUDE_PLUGIN_ROOT`.

**Names.** A plugin's skill or command is available as `/plugin:name` always, and as `/name` too unless the name is taken. The order is the user's own, then plugins (in the order they were installed), then the project's, so a repository cannot shadow a plugin's command and a plugin cannot shadow the user's. When the bare name is taken, the plugin's is reachable only as `/plugin:name`. This is Claude Code's behaviour, except that Claude Code always requires the prefix. MCP servers keep the names their config gives them, and a later plugin or the user's own `mcp.json` replaces an earlier server of the same name.

**Listing.** `teh skills`, `teh hooks` and `teh mcp` show plugin items with `plugin <name>` as the source.

## Consequences
- A Claude Code plugin works if it sticks to this layout. Parts teh does not run (agents, `LSP` servers, output styles, Claude Code-only hook events) are listed or ignored without failing the install.
- Installing from a marketplace is only as trustworthy as the marketplace and the printed summary. The summary shows hook commands and MCP launch commands but not what the scripts they call do; reading them is up to the user.
- A plugin can change after install only by being reinstalled, so what was approved is what runs. teh does not check for updates.
- **Deferred:** `teh plugin update` and update checks; adding a marketplace once and installing by name alone (`teh plugin install name`); marketplace `metadata.pluginRoot`, `strict: false` entries without a manifest, and entries pointing into a git subfolder; version pinning (`@ref`); plugin-supplied output styles; signature or checksum verification; running plugin hooks and servers in the sandbox; project-level plugin lists (`enabledPlugins` in a repo's settings), which would need the trust story for a repo naming code to fetch.
