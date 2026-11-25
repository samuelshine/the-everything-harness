# Extensions: output styles, hooks, MCP, skills and plugins

## Output styles
Output styles change how `teh` works and replies for a whole session. Pick one with `--output-style <name>`, or set `"outputStyle"` in settings:
- `explanatory` adds short "Insight" notes on why the code is shaped the way it is;
- `learning` hands you small key pieces to write, marked `TODO(human)`, and then reviews them;
- your own `~/.teh/output-styles/<name>.md` or `.claude/output-styles/<name>.md` files work too, including Claude Code's.

`teh styles` lists them.

## Hooks
Hooks run your own commands at fixed points in the loop, in Claude Code's format, so existing hook scripts work as they are. Put them under `"hooks"` in any settings file:
```json
{"hooks": {"PostToolUse": [{"matcher": "Edit|Write", "hooks": [{"type": "command", "command": "npx eslint --fix \"$CLAUDE_PROJECT_DIR\""}]}]}}
```
- **Events:** `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`, `SessionStart`, `SessionEnd`, `Notification`, `PreCompact`, and `SubagentStop` (an explore subagent is about to finish). The hook gets the event as JSON on stdin.
- **Blocking:** exit code 2 blocks the action, and stderr tells the model (or you, for a prompt) why. A `Stop` hook that exits 2 sends the model back to work.
- **Hook types:** a hook is a `command` (above), an `http` POST, or a `prompt` answered by a model.
  ```json
  {"hooks": {"PostToolUse": [{"matcher": "Write", "hooks": [{"type": "http", "url": "https://ci.example.com/hook", "headers": {"Authorization": "Bearer $CI_TOKEN"}, "allowedEnvVars": ["CI_TOKEN"], "timeout": 10}]}]}}
  ```
  An HTTP hook gets the event as the POST body and answers with the same JSON a command prints. Only a 2xx reply counts; any other result is a warning, not a block. Only variables in `allowedEnvVars` are filled into headers.
  ```json
  {"hooks": {"Stop": [{"hooks": [{"type": "prompt", "prompt": "Did the agent run the tests and report the result? $ARGUMENTS"}]}]}}
  ```
  A prompt hook asks a small, fast model (the explore model, else your main one; set `"model"` on the hook to choose) to answer `{"ok": true}` or `{"ok": false, "reason": "…"}`. Not ok blocks, and the reason goes to the model. Prompt hooks work on `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop` and `SubagentStop`.
- **SubagentStop:** fires when an explore subagent finishes, with `agent_type`, `agent_id` and `last_assistant_message`. Blocking it gives the subagent one more turn with your reason. The parent's `Stop` hook does not fire for subagents.
- **Permissions:** a `PreToolUse` hook can deny anything, even in `bypassPermissions` mode. Its `"allow"` skips the question but, unlike in Claude Code, never overrides a deny rule (ADR-0016).
- **Trust:** a repo's own hooks run only after `teh trust`. `teh hooks` lists every hook and whether it runs here.

## MCP servers
MCP servers add tools from outside `teh` (GitHub, a browser, a database). Configure them in Claude Code's format, in `.mcp.json` in the project, `~/.teh/mcp.json`, or `--mcp-config`:
```json
{"mcpServers": {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/", "headers": {"Authorization": "Bearer ${GITHUB_TOKEN}"}}}}
```
- **Transports:** stdio servers (`"command"`, `"args"`, `"env"`) and streamable HTTP servers (`"type": "http"`).
- **Signing in:** for a server that uses OAuth, run `teh mcp login <server>`. teh finds the server's sign-in page, registers itself, and opens your browser; tokens are kept in your keychain and refreshed. `teh mcp logout <server>` forgets them. For a server without self-registration, add `"oauth": {"clientId": "…"}` to its config. A static `"headers": {"Authorization": …}` still works.
- **Tool names:** each tool is named `mcp__<server>__<tool>`, so Claude Code permission rules carry over.
- **Permissions:** every MCP call asks first. `--allowedTools mcp__github` allows a whole server; `mcp__github__get_issue` allows one tool. `acceptEdits` doesn't cover MCP tools, and plan mode runs only the allowed ones.
- **Many tools:** when the servers' tool definitions would take more than a tenth of the model's context, they are left out of the prompt. The model sees their names and loads the ones it needs with `ToolSearch`, as in Claude Code. `TEH_TOOL_SEARCH=on` or `off` (or Claude Code's `ENABLE_TOOL_SEARCH`) overrides this.
- **Resources and prompts:** servers' resources can be listed and read by the model (`ListMcpResourcesTool`, `ReadMcpResourceTool`, which ask first like any MCP call). Their prompts are commands: `/mcp__<server>__<prompt> args`.
- **Changing tools:** when a server says its tools changed, the new list is used from the next model request.
- **Tool fingerprints:** the first time a server is used, a fingerprint of its tool names, descriptions and schemas is saved (`~/.teh/mcp-pins.json`). If it changes later, teh warns: a server that rewrites what its tools say can steer the model. Review with `teh mcp`, then accept with `teh mcp pin <server>`.
- **Sandbox:** add `"sandbox": true` to a stdio server to run it in the OS sandbox, which limits writes to the project and package caches.
- **Images** returned by a tool are passed to models that can see them.
- **Trust:** a repo's `.mcp.json` servers start only after `teh trust`.
- **Checking:** `teh mcp` starts each server and lists its tools, resources and prompts.

## Skills and commands
**Skills and commands** (ADR-0015). `teh` reads skills in the Agent Skills format and Claude Code's commands, so the ones you already have work as they are. It looks in `~/.teh/`, `~/.claude/`, and the project's `.teh/`, `.agents/` and `.claude/` folders; your own copy wins over a project's.
- `teh skills` lists them.
- `teh -p "/human tidy README.md"` runs one by name.
- The model also sees each skill's name and description, and loads a skill with the `Skill` tool when a request fits, for example "make this sound less like AI wrote it".
- `--skill-router embed` (or `TEH_SKILL_ROUTER=embed`) has a local embedding model (`nomic-embed-text`) suggest a skill before the model starts. `embed+confirm` also asks a small model, set with `TEH_SKILL_ROUTER_MODEL=ollama:qwen2.5:0.5b`, to check the suggestion. Both are off by default; see [evals/skill-routing](evals/skill-routing/README.md) for when they help.

## Plugins
A plugin bundles skills, commands, hooks and MCP servers so one install adds a whole workflow (ADR-0026). `teh` reads Claude Code's plugin layout, so plugins written for it work:
```
my-plugin/
  .claude-plugin/plugin.json   {"name": "my-plugin", "version": "1.0.0", "description": "…"}
  commands/*.md                slash commands
  skills/<name>/SKILL.md       skills
  agents/*.md                  kept, but not used until subagents land
  hooks/hooks.json             {"hooks": {"PostToolUse": [...]}}
  .mcp.json                    {"mcpServers": {...}}
```
Only `name` is required in the manifest. `commands`, `agents`, `skills`, `hooks` and `mcpServers` can add more paths (relative to the plugin, written inline for the last two).

- **Install:** `teh plugin install <source>`, where the source is a folder, a git URL (`https://…`, `ssh://…`, `git@host:path`, `file://…`), or `name@marketplace`. A marketplace is a folder or git repo with `.claude-plugin/marketplace.json` (`{"plugins": [{"name": "fmt", "source": "./plugins/fmt"}]}`); an entry's source can also be `{"source": "github", "repo": "owner/repo"}` or `{"source": "url", "url": "…"}`. teh copies the plugin to `~/.teh/plugins/<name>/` and records it in `~/.teh/plugins/installed.json`. Installing the same name again updates it.
- **Trust:** a plugin is code. Before installing, teh lists its commands, skills, hook commands and MCP server commands, and installs only if you say yes (or pass `--yes`). Without a terminal and without `--yes` it prints the list and installs nothing. After that, its hooks and MCP servers run like your own: no `teh trust` step, your full rights. Read the scripts the listed commands call before you agree.
- **Manage:** `teh plugin list`, `disable <name>` (keeps the files, stops loading them), `enable <name>`, `remove <name>`.
- **Names:** a plugin's command or skill is `/plugin:name`, and also `/name` when nothing of yours already has that name. Your own `~/.teh/` ones come first, then plugins, then the project's, so a repo cannot take over a plugin's command. `teh skills`, `teh hooks` and `teh mcp` show which plugin each item came from.
- **Plugin folder:** `${CLAUDE_PLUGIN_ROOT}` (or `${TEH_PLUGIN_ROOT}`) in a hook command or an MCP server's command, arguments, environment or URL becomes the plugin's folder. Both are also set as environment variables for hook commands and stdio servers.
- **Not yet:** update checks and `teh plugin update` (install again from the same source), adding a marketplace once and installing by bare name, version pinning, and plugins named in a repo's own settings. See ADR-0026.
