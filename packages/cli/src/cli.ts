// Argument parsing and dispatch, kept free of process globals so it can be tested.

import { existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type AgentEvent,
  builtinTools,
  type Checkpoint,
  CheckpointError,
  CheckpointStore,
  capableModels,
  chooseModel,
  countHooks,
  createProvider,
  DEFAULT_CACHE_RETENTION_DAYS,
  DEFAULT_CLEANUP_PERIOD_DAYS,
  DEFAULT_EMBED_MODEL,
  DEFAULT_STYLE,
  expandSkill,
  findProjectRoot,
  findSession,
  findStyle,
  HookRunner,
  isTrusted,
  type LoadedSession,
  listSessions,
  loadSettings,
  loadSkills,
  loadStyles,
  type ModelInfo,
  type OutputStyle,
  PERMISSION_MODES,
  type PermissionMode,
  type Provider,
  ProviderError,
  parseModelRef,
  parseSlash,
  pruneCaches,
  pruneSessions,
  type RestorePlan,
  ROUTER_MODES,
  type RouteResult,
  type RouterMode,
  runAgent,
  SessionLog,
  type Skill,
  SkillRouter,
  setProjectSetting,
  setTrusted,
  setUserSetting,
  similarNames,
  TranscriptCache,
  tehHome,
  triage,
  VERSION,
} from "@everything-harness/core";
import { askTrust, type TerminalIo, TuiApp } from "@everything-harness/tui";
import { planMcp, printMcp, startMcp } from "./mcp";
import { printHooks, printPermissions, runPermissions, SANDBOX_MODES, type SandboxMode, trust } from "./permissions";
import { rewind } from "./rewind";

export type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  // Piped stdin, or undefined when stdin is a terminal.
  stdin: () => Promise<string | undefined>;
  // Ask the person a yes/no question; undefined when there is no terminal to ask on.
  confirm?: (question: string) => Promise<boolean>;
  // Ask for a line of text; undefined when there is no terminal.
  ask?: (question: string) => Promise<string | undefined>;
  // The terminal for the interactive UI; undefined when stdin or stdout is not a terminal.
  terminal?: () => TerminalIo;
};

export type Deps = { provider?: (name: string) => Provider };

export const USAGE = `Usage: teh [options] [prompt]
       teh -p [options] [prompt]
       teh models
       teh rewind [point] | teh undo | teh sessions | teh checkpoints | teh restore <id>
       teh skills | teh styles | teh hooks | teh mcp | teh permissions | teh trust

Start the interactive terminal UI (full screen), optionally with a first prompt. With -p, run
one prompt headlessly and print the result; the prompt can also be piped on stdin.

Options:
  -p, --print                   Run headlessly: one prompt, print the result, exit
  --inline                      Draw the interactive UI inline in the scrollback instead of full screen
  -c, --continue                Continue the most recent session started in this directory (without
                                it a new session starts). Its on-screen
                                transcript is cached for 3 days ("cacheRetentionDays" in
                                ~/.teh/settings.json); the conversation itself is kept after that
  -r, --resume <id>             Continue a session by id (or prefix); \`teh sessions\` lists them
  --model <provider:model>      Model to use, e.g. ollama:gemma4:e4b (or set TEH_MODEL; a resumed
                                session keeps its model unless you pass one). Without it, teh picks
                                an installed model to fit the task and keeps it for the session
  --output-format <format>      text (default), json or stream-json
  --permission-mode <mode>      default (ask; denied when headless), acceptEdits, plan, bypassPermissions
  --allowedTools <rules...>     Allow without asking, e.g. "Edit" "Bash(npm test:*)" "Bash(git add *)"
  --disallowedTools <rules...>  Always deny, e.g. "Bash(git push:*)" "Read(.env)"
                                Rules can also go in .teh/settings.json or .claude/settings.json:
                                {"permissions": {"allow": [...], "ask": [...], "deny": [...]}}.
                                Read-only commands (ls, cat, grep, git status, …) never ask
  --add-dir <dir...>            Extra directories the agent may change
  --mcp-config <file|json...>   MCP servers to add, as a file or JSON in .mcp.json's format
                                (also read: .mcp.json once trusted, and ~/.teh/mcp.json)
  --strict-mcp-config           Use only the servers from --mcp-config
  --sandbox <mode>              auto (default): run shell commands in the OS sandbox when there is
                                one (macOS Seatbelt, Linux bubblewrap); on: refuse to run without
                                it; off: no sandbox (or set TEH_SANDBOX). Commands that ran without
                                asking get a read-only sandbox with no network
  --max-turns <n>               Stop after n model turns (default 50)
  --output-style <name>         How teh works and replies: default, explanatory, learning, or your
                                own from ~/.teh/output-styles or .claude/output-styles (or set
                                "outputStyle" in settings; a resumed session keeps its style)
  --skill-router <mode>         off (default), embed, or embed+confirm: suggest skills to the model
                                before it starts (or set TEH_SKILL_ROUTER). Uses nomic-embed-text
                                (TEH_SKILL_ROUTER_EMBED_MODEL) and, for confirm, a small model
                                set with TEH_SKILL_ROUTER_MODEL, e.g. ollama:qwen2.5:0.5b
  -y, --yes                     Restore without asking (rewind, undo, restore)
  -v, --version                 Print the version
  -h, --help                    Show this help

Commands:
  models                        List local Ollama models and whether they support tools
  rewind [point]                Go back to any step of the latest session: lists titled points,
                                then restores code, conversation or both
      --code-only               Restore files only
      --conversation-only       Restore the conversation only
      --session <id>            Rewind another session (see \`teh sessions\`)
  skills                        List skills and commands; run one with teh -p "/name args"
  styles                        List output styles (--output-style <name>)
  hooks                         List hook commands from settings (Claude Code's "hooks" format)
  mcp                           Start the configured MCP servers and list their tools
  sessions                      List this project's sessions, newest first
  sessions rm <id>              Delete a session and its cached view (its checkpoints stay)
  checkpoints                   List file snapshots taken before each run changed anything
  permissions                   Show the permission rules in effect and where each comes from
  trust [--revoke]              Let this project's own allow rules, hooks, skill grants and .mcp.json apply
  undo                          Put files back as they were before the last run that changed them
  restore <id>                  Put files back to a checkpoint (undo a restore with the id it prints)
`;

const OUTPUT_FORMATS = ["text", "json", "stream-json"] as const;
type OutputFormat = (typeof OUTPUT_FORMATS)[number];

export async function run(argv: string[], io: Io, deps: Deps = {}): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (e) {
    io.err(`teh: ${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  const { values: v, positionals } = parsed;
  const makeProvider = deps.provider ?? ((name: string) => createProvider(name, io.env));

  if (v.version) {
    io.out(`teh ${VERSION}\n`);
    return 0;
  }
  if (positionals[0] === "models") return listModels(io, makeProvider);
  if (positionals[0] === "checkpoints") return listCheckpoints(io);
  if (positionals[0] === "sessions" && positionals[1] === "rm") return removeSession(io, positionals[2]);
  if (positionals[0] === "sessions") return printSessions(io);
  if (positionals[0] === "skills") return printSkills(io);
  if (positionals[0] === "styles") return printStyles(io);
  if (positionals[0] === "hooks") return printHooks(io, userHome(io));
  if (positionals[0] === "mcp") return printMcp(io, v["mcp-config"] ?? [], v["strict-mcp-config"] ?? false);
  if (positionals[0] === "trust") return trust(io, v.revoke ?? false, userHome(io));
  const sandboxMode = (v.sandbox ?? io.env.TEH_SANDBOX) as SandboxMode | undefined;
  if (sandboxMode !== undefined && !SANDBOX_MODES.includes(sandboxMode))
    return usageError(io, `--sandbox must be one of ${SANDBOX_MODES.join(", ")}`);
  if (positionals[0] === "permissions") {
    const root = findProjectRoot(io.cwd);
    return printPermissions(io, loadSkills(tehHome(io.env), root, userHome(io)).skills, userHome(io), sandboxMode);
  }
  if (positionals[0] === "rewind") {
    if (v["code-only"] && v["conversation-only"]) return usageError(io, "choose --code-only or --conversation-only");
    return rewind(io, {
      ...(positionals[1] ? { point: positionals[1] } : {}),
      ...(v["code-only"]
        ? { scope: "code" as const }
        : v["conversation-only"]
          ? { scope: "conversation" as const }
          : {}),
      ...(v.session ? { session: v.session } : {}),
      yes: v.yes ?? false,
    });
  }
  if (positionals[0] === "undo") return restore(io, undefined, v.yes ?? false);
  if (positionals[0] === "restore") {
    if (!positionals[1]) return usageError(io, "restore needs a checkpoint id; `teh checkpoints` lists them");
    return restore(io, positionals[1], v.yes ?? false);
  }
  const interactive = !v.print;
  if (v.help || (interactive && !io.terminal && positionals.length === 0)) {
    io.out(USAGE);
    return 0;
  }
  if (interactive && !io.terminal) {
    io.err("teh: the interactive UI needs a terminal; use -p to run headlessly\n");
    return 2;
  }

  const format = (v["output-format"] ?? "text") as OutputFormat;
  if (!OUTPUT_FORMATS.includes(format))
    return usageError(io, `--output-format must be one of ${OUTPUT_FORMATS.join(", ")}`);
  const flagMode = v["permission-mode"] as PermissionMode | undefined;
  if (flagMode !== undefined && !PERMISSION_MODES.includes(flagMode))
    return usageError(io, `--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
  const maxTurns = v["max-turns"] === undefined ? 50 : Number(v["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) return usageError(io, "--max-turns must be a positive integer");

  const typed = positionals.join(" ").trim() || (interactive ? "" : ((await io.stdin())?.trim() ?? ""));
  if (!typed && !interactive) return usageError(io, "no prompt given");

  const root = findProjectRoot(io.cwd);
  // Each directory is its own project: sessions and their caches belong to the folder teh
  // was started in. Settings, skills and checkpoints still come from the repository root.
  const dir = resolve(io.cwd);
  const home = tehHome(io.env);
  const startSettings = loadSettings(home, root, userHome(io));
  // Cleanup (ADR-0004, ADR-0018): UI caches after a few idle days, whole sessions after
  // cleanupPeriodDays, and checkpoints only when checkpointRetentionDays is set.
  const cacheDays = startSettings.cacheRetentionDays ?? DEFAULT_CACHE_RETENTION_DAYS;
  pruneCaches(home, cacheDays);
  pruneSessions(home, startSettings.cleanupPeriodDays ?? DEFAULT_CLEANUP_PERIOD_DAYS);
  if (startSettings.checkpointRetentionDays) {
    const days = startSettings.checkpointRetentionDays;
    await pruneCheckpointsDaily(new CheckpointStore(home, root), days).catch((e) =>
      io.err(`teh: warning: could not prune old checkpoints: ${(e as Error).message}\n`),
    );
  }
  // Starting the UI in a folder for the first time asks whether to trust it (ADR-0018).
  const term = interactive && io.terminal ? io.terminal() : undefined;
  if (term && !isTrusted(home, root) && root !== userHome(io)) {
    const project = loadSettings(home, root, userHome(io));
    const hookCount = countHooks(project.hooks.project);
    const found = [
      project.project.allow.length ? `${project.project.allow.length} allow rule(s)` : "",
      hookCount ? `${hookCount} hook command(s)` : "",
      existsSync(join(root, ".mcp.json")) ? "an .mcp.json" : "",
    ].filter(Boolean);
    const answer = await askTrust(term, { folder: root, color: !io.env.NO_COLOR && io.env.TERM !== "dumb", found });
    if (answer === "quit") return 0;
    if (answer === "trust") setTrusted(home, root, true);
  }
  // The mode to start in: the flag, else permissions.defaultMode (ADR-0003). A project may
  // choose plan or default; acceptEdits only once the folder is trusted; bypass never.
  const trustedNow = isTrusted(home, root);
  const projectMode = startSettings.defaultMode.project;
  const projectModeOk =
    projectMode === "default" || projectMode === "plan" || (projectMode === "acceptEdits" && trustedNow);
  if (projectMode && !projectModeOk)
    io.err(
      `teh: warning: ignoring this project's permissions.defaultMode "${projectMode}" (${trustedNow ? "a project cannot bypass permissions" : "the folder is not trusted"})\n`,
    );
  const mode: PermissionMode =
    flagMode ?? (projectModeOk ? projectMode : undefined) ?? startSettings.defaultMode.user ?? "default";
  const loaded = loadSkills(home, root, userHome(io));
  for (const p of loaded.problems) io.err(`teh: warning: skipped ${p.path}: ${p.message}\n`);
  const perms = runPermissions(io, {
    mode,
    allowed: v.allowedTools ?? [],
    disallowed: v.disallowedTools ?? [],
    skills: loaded.skills,
    home: userHome(io),
    addDirs: v["add-dir"] ?? [],
    ...(sandboxMode ? { sandbox: sandboxMode } : {}),
  });
  if (perms.sandboxError) return usageError(io, `${perms.sandboxError}\n  fix: install it, or pass --sandbox off`);
  for (const w of perms.warnings) io.err(`teh: warning: ${w}\n`);
  const skills = perms.skills;
  // "/name args" runs a skill or command (ADR-0015).
  let prompt = typed;
  // The interactive UI handles "/name" itself.
  const slash = interactive ? undefined : parseSlash(typed);
  if (slash) {
    const skill = skills.find((s) => s.name === slash.name && s.userInvocable);
    if (!skill) {
      const near = similarNames(slash.name, skills);
      return usageError(
        io,
        `no skill or command named /${slash.name}${near.length ? `; did you mean ${near.map((n) => `/${n}`).join(", ")}?` : ""}\n  \`teh skills\` lists them`,
      );
    }
    prompt = expandSkill(skill, slash.args);
  }
  let resumed: LoadedSession | undefined;
  if (v.continue && v.resume) return usageError(io, "use either --continue or --resume, not both");
  if (v.continue) {
    const latest = listSessions(home, dir)[0];
    if (!latest) return usageError(io, "no earlier session in this project to continue");
    resumed = findSession(home, dir, latest.id);
  } else if (v.resume) {
    resumed = findSession(home, dir, v.resume);
    if (!resumed) return usageError(io, `no single session matches ${v.resume}; \`teh sessions\` lists them`);
  }

  const routerMode = (v["skill-router"] ?? io.env.TEH_SKILL_ROUTER ?? "off") as RouterMode;
  if (!ROUTER_MODES.includes(routerMode))
    return usageError(io, `--skill-router must be one of ${ROUTER_MODES.join(", ")}`);
  if (routerMode === "embed+confirm" && !io.env.TEH_SKILL_ROUTER_MODEL)
    return usageError(io, "--skill-router embed+confirm needs TEH_SKILL_ROUTER_MODEL, e.g. ollama:qwen2.5:0.5b");

  const style = pickStyle(io, v["output-style"], resumed?.outputStyle);
  if ("error" in style) return usageError(io, style.error);

  // No pinned model: teh picks one for the task from the local models (ADR-0014). The
  // rules cost no tokens, and the choice holds for the session so its cache is kept.
  let modelSpec =
    v.model ?? resumed?.model ?? io.env.TEH_MODEL ?? startSettings.model.project ?? startSettings.model.user;
  let installed: ModelInfo[] | undefined;
  let autoReason: string | undefined;
  if (!modelSpec) {
    try {
      installed = await makeProvider("ollama").listModels();
    } catch (e) {
      io.err(
        `teh: no model selected, and the local models could not be listed (${(e as Error).message})\n  fix: start Ollama, or pass --model <provider:model>\n`,
      );
      return 2;
    }
    const sorted = triage(typed, { planMode: mode === "plan" });
    const choice = chooseModel(installed, sorted.tier);
    if (!choice) {
      io.err(
        "teh: no model selected, and no installed model supports tool calling\n  fix: `ollama pull qwen2.5:14b`, or pass --model ollama:<name>; `teh models` lists local models\n",
      );
      return 2;
    }
    modelSpec = `ollama:${choice.id}`;
    autoReason = `${sorted.tier}: ${sorted.reason}`;
  }

  const mcpPlan = planMcp(io, v["mcp-config"] ?? [], v["strict-mcp-config"] ?? false);
  for (const w of mcpPlan.warnings) io.err(`teh: warning: ${w}\n`);

  const started = performance.now();
  let mcp: Awaited<ReturnType<typeof startMcp>>;
  try {
    const ref = parseModelRef(modelSpec);
    const provider = makeProvider(ref.provider);
    const probe = await provider.probe(ref.model);
    if (!probe.supportsTools) {
      throw new ProviderError(
        "bad_request",
        `${modelSpec} does not support tool calling`,
        "choose a model listed with tools by `teh models`",
      );
    }
    for (const note of probe.notes) io.err(`teh: warning: ${note}\n`);

    const skillRoute =
      slash || interactive ? undefined : await routeSkills(io, routerMode, typed, skills, home, makeProvider);
    if (format === "text" && style.style.name !== "default") io.err(`› output style: ${style.style.name}\n`);
    if (format === "text" && autoReason && !interactive)
      io.err(`› model: ${modelSpec} · chosen for this task (${autoReason}) · --model pins one\n`);
    if (skillRoute && format === "text" && skillRoute.chosen.length) {
      const scores = skillRoute.candidates.filter((c) => skillRoute.chosen.includes(c.name));
      io.err(`› skill router suggests ${scores.map((c) => `${c.name} (${c.score})`).join(", ")}\n`);
    }
    mcp = await startMcp(io, mcpPlan.servers);
    const tools = [...builtinTools, ...(mcp?.tools ?? [])];
    const session = new SessionLog(home, dir, undefined, resumed);
    const store = new CheckpointStore(home, root);
    const denied: Denied[] = [];
    const text = textOutput(io, denied);
    const checkpoint = { taken: false };
    const hooks = new HookRunner({
      config: perms.hooks,
      cwd: io.cwd,
      projectRoot: root,
      sessionId: session.id,
      transcriptPath: session.path,
      env: io.env,
    });
    if (term) {
      const hooksFor = (s: SessionLog) =>
        new HookRunner({
          config: perms.hooks,
          cwd: io.cwd,
          projectRoot: root,
          sessionId: s.id,
          transcriptPath: s.path,
          env: io.env,
        });
      const app: TuiApp = new TuiApp({
        terminal: term,
        color: !io.env.NO_COLOR && io.env.TERM !== "dumb",
        fullscreen: !v.inline && io.env.TERM !== "dumb" && startSettings.screen !== "inline",
        transcript: new TranscriptCache(home, dir),
        cacheDays,
        saveSetting: (scope, key, value) => {
          const ok = scope === "user" ? setUserSetting(home, key, value) : setProjectSetting(root, key, value);
          if (!ok) io.err(`teh: warning: could not save ${key}: the settings file is not a JSON object\n`);
        },
        settings: {
          model: startSettings.model,
          defaultMode: startSettings.defaultMode,
          ...(startSettings.cleanupPeriodDays ? { cleanupPeriodDays: startSettings.cleanupPeriodDays } : {}),
          ...(startSettings.checkpointRetentionDays
            ? { checkpointRetentionDays: startSettings.checkpointRetentionDays }
            : {}),
        },
        models: await localModels(makeProvider, installed),
        useModel: async (label: string) => {
          const r = parseModelRef(label);
          const p = makeProvider(r.provider);
          const info = await p.probe(r.model);
          if (!info.supportsTools) throw new Error(`${label} does not support tool calling`);
          return {
            provider: p,
            model: r.model,
            label,
            ...(info.contextWindow ? { contextWindow: info.contextWindow } : {}),
            reason: "",
          };
        },
        ...(probe.contextWindow ? { contextWindow: probe.contextWindow } : {}),
        statusInfo: [
          ["Project", dir === root ? dir : `${dir} (repository: ${root})`],
          ["Trust", isTrusted(home, root) ? "trusted" : "not trusted: the folder's own configuration is ignored"],
          ["MCP servers", String(mcpPlan.servers.length)],
          ["Skills", String(skills.length)],
        ],
        ...(installed
          ? {
              pickModel: async (first: string, planMode: boolean) => {
                const sorted = triage(first, { planMode });
                const id = chooseModel(installed, sorted.tier)?.id ?? ref.model;
                const chosen = makeProvider("ollama");
                const info = await chosen.probe(id);
                return {
                  provider: chosen,
                  model: id,
                  label: `ollama:${id}`,
                  ...(info.contextWindow ? { contextWindow: info.contextWindow } : {}),
                  reason: `${sorted.tier}: ${sorted.reason}`,
                };
              },
            }
          : {}),
        agent: {
          provider,
          model: ref.model,
          cwd: io.cwd,
          tools,
          ...(mcp?.instructions.length ? { mcpInstructions: mcp.instructions } : {}),
          permissions: perms.config,
          ...(perms.sandbox ? { sandbox: perms.sandbox } : {}),
          ...(style.style.name !== "default" ? { outputStyle: style.style } : {}),
          addDirs: v["add-dir"] ?? [],
          maxTurns,
          skills,
          skillListingChars: Math.max(4000, Math.round((probe.contextWindow ?? 0) * 0.04)),
        },
        modelLabel: modelSpec,
        session,
        newSession: () => new SessionLog(home, dir),
        history: resumed?.items ?? [],
        resumed: resumed !== undefined,
        ...(typed ? { initialPrompt: typed } : {}),
        hooksFor,
        onNotify: (message) => {
          const h = app.currentHooks;
          if (h?.has("Notification")) void h.run({ hook_event_name: "Notification", message });
        },
        checkpoint: async ({ first, title }, p) =>
          (await store.snapshot(first ? "turn" : "step", app.currentSession.id, first ? p : title)).sha,
      });
      const code = await app.start();
      const h = app.currentHooks;
      if (h?.has("SessionEnd")) await h.run({ hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
      return code;
    }
    const onEvent = format === "stream-json" ? streamJson(io) : format === "text" ? text.onEvent : trackDenied(denied);
    if (format === "stream-json") {
      io.out(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: session.id, model: modelSpec, cwd: io.cwd, tools: tools.map((t) => t.spec.name), mcp_servers: (mcp?.servers ?? []).map((s) => ({ name: s.name, status: s.ok ? "connected" : "failed" })), permission_mode: mode, sandbox: perms.sandbox?.kind ?? "none" })}\n`,
      );
    }

    const res = await runAgent({
      provider,
      model: ref.model,
      prompt,
      cwd: io.cwd,
      tools,
      ...(mcp?.instructions.length ? { mcpInstructions: mcp.instructions } : {}),
      permissions: perms.config,
      ...(perms.sandbox ? { sandbox: perms.sandbox } : {}),
      ...(style.style.name !== "default" ? { outputStyle: style.style } : {}),
      // Headless runs cannot ask, so anything that needs approval is denied (ADR-0008).
      ask: async () => false,
      addDirs: v["add-dir"] ?? [],
      session,
      maxTurns,
      onEvent: (e) => {
        if (e.type === "checkpoint") checkpoint.taken = true;
        onEvent(e);
      },
      ...(resumed ? { history: resumed.items } : {}),
      hooks,
      hookSessionStart: resumed ? "resume" : "startup",
      ...(slash ? { slash } : {}),
      ...(skillRoute ? { skillRoute } : {}),
      skills,
      skillListingChars: Math.max(4000, Math.round((probe.contextWindow ?? 0) * 0.04)),
      checkpoint: async ({ first, title }) =>
        (await store.snapshot(first ? "turn" : "step", session.id, first ? prompt : title)).sha,
    });

    if (hooks.has("SessionEnd")) {
      const end = await hooks.run({ hook_event_name: "SessionEnd", reason: "other" });
      for (const m of end.messages) onEvent({ type: "hook", event: "SessionEnd", message: m });
    }
    const isError = ["max_turns", "error", "hook_blocked", "hook_stopped"].includes(res.stopReason);
    if (format === "text") {
      text.finish();
      if (checkpoint.taken) {
        io.err("teh: `teh undo` reverts this run's file changes; `teh rewind` goes back to any step\n");
      }
      if (res.stopReason === "max_turns") io.err(`teh: stopped after ${maxTurns} turns (--max-turns)\n`);
      if (denied.length) io.err(denialHint(denied));
    } else {
      io.out(
        `${JSON.stringify({
          type: "result",
          subtype: res.stopReason === "max_turns" ? "error_max_turns" : "success",
          is_error: isError,
          result: res.result,
          stop_reason: res.stopReason,
          num_turns: res.turns,
          duration_ms: Math.round(performance.now() - started),
          session_id: session.id,
          usage: res.usage,
          denied_actions: denied.map((d) => d.summary),
          suggested_rules: [...new Set(denied.flatMap((d) => (d.suggestion ? [d.suggestion] : [])))],
        })}\n`,
      );
    }
    return isError ? 1 : 0;
  } catch (e) {
    if (e instanceof ProviderError) {
      io.err(`teh: ${e.message}\n${e.hint ? `  fix: ${e.hint}\n` : ""}`);
      return 1;
    }
    throw e;
  } finally {
    await mcp?.close();
  }
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      print: { type: "boolean", short: "p" },
      model: { type: "string" },
      "output-format": { type: "string" },
      "permission-mode": { type: "string" },
      allowedTools: { type: "string", multiple: true },
      disallowedTools: { type: "string", multiple: true },
      "add-dir": { type: "string", multiple: true },
      "max-turns": { type: "string" },
      yes: { type: "boolean", short: "y" },
      continue: { type: "boolean", short: "c" },
      resume: { type: "string", short: "r" },
      "code-only": { type: "boolean" },
      "conversation-only": { type: "boolean" },
      session: { type: "string" },
      "skill-router": { type: "string" },
      revoke: { type: "boolean" },
      sandbox: { type: "string" },
      "output-style": { type: "string" },
      "mcp-config": { type: "string", multiple: true },
      "strict-mcp-config": { type: "boolean" },
      inline: { type: "boolean" },
      version: { type: "boolean", short: "v" },
      help: { type: "boolean", short: "h" },
    },
  });
}

function usageError(io: Io, message: string): number {
  io.err(`teh: ${message}\n`);
  return 2;
}

async function listModels(io: Io, makeProvider: (name: string) => Provider): Promise<number> {
  try {
    const models = await makeProvider("ollama").listModels();
    if (models.length === 0) {
      io.out("No Ollama models installed. Try: ollama pull qwen2.5:14b\n");
      return 0;
    }
    io.out("Ollama models (use as --model ollama:<name>):\n");
    for (const m of models) {
      const tools = m.supportsTools ? "tools" : "no tools";
      const ctx = m.contextWindow ? `${Math.round(m.contextWindow / 1024)}k max context` : "";
      io.out(`  ${m.id.padEnd(32)} ${tools.padEnd(9)} ${ctx}\n`);
    }
    return 0;
  } catch (e) {
    if (e instanceof ProviderError) {
      io.err(`teh: ${e.message}\n${e.hint ? `  fix: ${e.hint}\n` : ""}`);
      return 1;
    }
    throw e;
  }
}

// Plain text: the answer streams to stdout; tool activity goes to stderr.
type Denied = { summary: string; suggestion?: string };

function noteDenied(denied: Denied[], e: Extract<AgentEvent, { type: "approval" }>) {
  // A hook's block is the project's policy, not something a rule or flag should open up.
  if (e.reason.startsWith("PreToolUse hook")) return;
  denied.push({ summary: e.summary, ...(e.suggestion ? { suggestion: e.suggestion } : {}) });
}

// What to pass next time so the denied actions run, shell-quoted for copying.
function denialHint(denied: Denied[]): string {
  const rules = [...new Set(denied.flatMap((d) => (d.suggestion ? [d.suggestion] : [])))];
  const edits = rules.includes("Edit");
  const others = rules.filter((r) => r !== "Edit");
  const lines = [`teh: ${denied.length} action(s) needed approval and were denied. To allow them next time:`];
  if (edits) lines.push("  --permission-mode acceptEdits   (file edits in this project)");
  if (others.length) {
    lines.push(`  --allowedTools ${others.map((r) => `'${r.replace(/'/g, "'\\''")}'`).join(" ")}`);
    lines.push('  or add them to "permissions": {"allow": [...]} in .teh/settings.json');
  }
  if (!rules.length) lines.push("  see the reasons above; `teh permissions` shows the rules in effect");
  return `${lines.join("\n")}\n`;
}

function textOutput(io: Io, denied: Denied[]) {
  let midLine = false;
  const endLine = () => {
    if (midLine) io.out("\n");
    midLine = false;
  };
  const onEvent = (e: AgentEvent) => {
    if (e.type === "text_delta") {
      io.out(e.text);
      midLine = !e.text.endsWith("\n");
    } else if (e.type === "tool_call") {
      endLine();
      io.err(`› ${e.summary ?? e.name}\n`);
    } else if (e.type === "approval" && e.behavior === "deny") {
      noteDenied(denied, e);
      io.err(`✗ denied: ${e.summary} (${e.reason})\n`);
    } else if (e.type === "warning") {
      io.err(`teh: warning: ${e.message}\n`);
    } else if (e.type === "hook") {
      io.err(`› ${e.event} hook: ${e.message}\n`);
    } else if (e.type === "tool_result" && e.isError && !e.content.startsWith("Permission denied")) {
      const line = e.content.split("\n").find((l) => l.trim() && l !== "[stderr]") ?? e.content;
      io.err(`  ! ${line}\n`);
    }
  };
  return { onEvent, finish: endLine };
}

function streamJson(io: Io) {
  return (e: AgentEvent) => io.out(`${JSON.stringify(e)}\n`);
}

function trackDenied(denied: Denied[]) {
  return (e: AgentEvent) => {
    if (e.type === "approval" && e.behavior === "deny") noteDenied(denied, e);
  };
}

const shortSha = (sha: string) => sha.slice(0, 8);
const pad = (n: number) => String(n).padStart(2, "0");
// Local time, which is what people compare against when picking a checkpoint.
const when = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

async function listCheckpoints(io: Io): Promise<number> {
  const store = new CheckpointStore(tehHome(io.env), findProjectRoot(io.cwd));
  const all = await store.list();
  if (all.length === 0) {
    io.out("No checkpoints yet. One is taken before each run's first change.\n");
    return 0;
  }
  io.out(`Checkpoints for ${store.root} (newest first; restore with \`teh restore <id>\`):\n`);
  for (const c of all) {
    const kind = c.kind === "restore" ? "before restore" : c.kind === "step" ? "before step" : "before run";
    io.out(`  ${shortSha(c.sha)}  ${when(c.time)}  ${kind.padEnd(14)}  ${c.label}\n`);
  }
  return 0;
}

// `ref` undefined means undo: go back to the newest run checkpoint that differs from now.
async function restore(io: Io, ref: string | undefined, yes: boolean): Promise<number> {
  const store = new CheckpointStore(tehHome(io.env), findProjectRoot(io.cwd));
  try {
    const why = store.unavailable();
    if (why) return usageError(io, why);
    let target: Checkpoint | undefined;
    if (ref) {
      target = await store.find(ref);
      if (!target) return usageError(io, `no checkpoint ${ref}; \`teh checkpoints\` lists them`);
    }
    const candidates = target ? [target] : (await store.list()).filter((c) => c.kind === "turn");
    if (candidates.length === 0) {
      io.out("Nothing to undo: no run has changed files here yet.\n");
      return 0;
    }
    const current = await store.snapshot("restore", "", `before restoring ${ref ?? "(undo)"}`);
    let plan: RestorePlan | undefined;
    for (const c of candidates) {
      const p = await store.plan(current, c);
      if (p.write.length || p.remove.length) {
        plan = p;
        break;
      }
    }
    if (!plan) {
      io.out(ref ? "Files already match that checkpoint.\n" : "Nothing to undo: files match every checkpoint.\n");
      return 0;
    }
    io.out(`Restore files to ${shortSha(plan.target.sha)} (${when(plan.target.time)}, ${plan.target.label}):\n`);
    for (const f of plan.write) io.out(`  restore  ${f}\n`);
    for (const f of plan.remove) io.out(`  delete   ${f}\n`);
    for (const f of plan.skipped) io.out(`  keep     ${f}  (not covered by snapshots)\n`);
    if (!yes) {
      if (!io.confirm) return usageError(io, "no terminal to confirm on; re-run with --yes");
      if (!(await io.confirm("Restore these files?"))) {
        io.out("Nothing changed.\n");
        return 1;
      }
    }
    await store.apply(plan);
    io.out(`Restored. To undo this restore: teh restore ${shortSha(current.sha)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof CheckpointError) {
      io.err(`teh: ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

function removeSession(io: Io, ref: string | undefined): number {
  if (!ref) return usageError(io, "usage: teh sessions rm <id>");
  const home = tehHome(io.env);
  const dir = resolve(io.cwd);
  const found = findSession(home, dir, ref);
  if (!found) return usageError(io, `no single session matches ${ref}; \`teh sessions\` lists them`);
  rmSync(found.path, { force: true });
  rmSync(new TranscriptCache(home, dir).path(found.id), { force: true });
  io.out(`Deleted session ${found.id.slice(0, 18)} (${found.prompts} prompt${found.prompts === 1 ? "" : "s"}).\n`);
  return 0;
}

function printSessions(io: Io): number {
  const root = resolve(io.cwd);
  const all = listSessions(tehHome(io.env), root);
  if (all.length === 0) {
    io.out("No sessions yet in this project.\n");
    return 0;
  }
  io.out(`Sessions for ${root} (newest first; continue one with \`teh -p -r <id> "..."\`):\n`);
  for (const s of all) {
    const first = s.firstPrompt.replace(/\s+/g, " ");
    const label = first.length > 60 ? `${first.slice(0, 59)}…` : first;
    const n = `${s.prompts} prompt${s.prompts === 1 ? "" : "s"}`;
    io.out(`  ${s.id.slice(0, 18)}  ${when(s.updated)}  ${n.padEnd(10)}  ${(s.model ?? "").padEnd(22)}  ${label}\n`);
  }
  return 0;
}

// Installed models able to run the agent, as provider:model labels; empty when Ollama is down.
async function localModels(makeProvider: (name: string) => Provider, known?: ModelInfo[]): Promise<string[]> {
  try {
    const list = known ?? (await makeProvider("ollama").listModels());
    return capableModels(list).map((m) => `ollama:${m.id}`);
  } catch {
    return [];
  }
}

// Checkpoint pruning rewrites history and runs git gc, so it runs at most once a day.
async function pruneCheckpointsDaily(store: CheckpointStore, days: number): Promise<number> {
  const stamp = join(store.gitDir, "teh-pruned-at");
  const DAY = 24 * 60 * 60 * 1000;
  if (!existsSync(store.gitDir)) return 0;
  if (existsSync(stamp) && Date.now() - statSync(stamp).mtimeMs < DAY) return 0;
  const n = await store.prune(new Date(Date.now() - days * DAY));
  writeFileSync(stamp, `${new Date().toISOString()}\n`);
  return n;
}

// The home directory skills are read from, overridable for tests through HOME.
const userHome = (io: Io) => io.env.HOME || io.env.USERPROFILE || homedir();

// --output-style, else the resumed session's, else settings (project over user), else default.
function pickStyle(
  io: Io,
  flag: string | undefined,
  resumed: string | undefined,
): { style: OutputStyle } | { error: string } {
  const root = findProjectRoot(io.cwd);
  const home = tehHome(io.env);
  const { styles, problems } = loadStyles(home, root, userHome(io));
  for (const p of problems) io.err(`teh: warning: skipped ${p.path}: ${p.message}\n`);
  const settings = loadSettings(home, root, userHome(io)).outputStyle;
  const name = flag ?? resumed ?? settings.project ?? settings.user ?? DEFAULT_STYLE;
  const style = findStyle(styles, name);
  if (style) return { style };
  const list = styles.map((s) => s.name).join(", ");
  const where = flag ? "--output-style" : resumed ? "the resumed session" : "settings outputStyle";
  return { error: `no output style named "${name}" (from ${where}); available: ${list}\n  \`teh styles\` lists them` };
}

function printStyles(io: Io): number {
  const root = findProjectRoot(io.cwd);
  const home = tehHome(io.env);
  const { styles, problems } = loadStyles(home, root, userHome(io));
  const settings = loadSettings(home, root, userHome(io)).outputStyle;
  const active = (settings.project ?? settings.user ?? DEFAULT_STYLE).toLowerCase();
  io.out('Output styles (use with --output-style <name>, or set "outputStyle" in settings):\n');
  for (const s of styles) {
    const mark = s.name.toLowerCase() === active ? "*" : " ";
    const from = s.source === "builtin" ? "built-in" : `${s.source}`;
    io.out(`${mark} ${s.name.padEnd(20)} ${from.padEnd(9)} ${s.description}\n`);
  }
  io.out(
    "\n* is the default for this project. Add your own at ~/.teh/output-styles/<name>.md (Claude Code styles work as they are).\n",
  );
  for (const p of problems) io.out(`  skipped ${p.path}: ${p.message}\n`);
  return 0;
}

function printSkills(io: Io): number {
  const root = findProjectRoot(io.cwd);
  const { skills, problems } = loadSkills(tehHome(io.env), root, userHome(io));
  if (skills.length === 0 && problems.length === 0) {
    io.out(
      "No skills or commands found.\nAdd one at ~/.teh/skills/<name>/SKILL.md or .claude/skills/<name>/SKILL.md (Claude Code skills work as they are).\n",
    );
    return 0;
  }
  if (skills.length) io.out('Skills and commands (run one with: teh -p "/name args"):\n');
  for (const s of skills) {
    const how = s.kind === "command" ? "command" : s.modelInvocable ? "skill" : "skill, /name only";
    const usage = s.argumentHint ? `/${s.name} ${s.argumentHint}` : `/${s.name}`;
    const desc = s.description.replace(/\s+/g, " ");
    io.out(
      `  ${usage.padEnd(28)} ${`${s.source} ${how}`.padEnd(24)} ${desc.length > 70 ? `${desc.slice(0, 69)}…` : desc}\n`,
    );
  }
  for (const p of problems) io.out(`  skipped ${p.path}: ${p.message}\n`);
  return 0;
}

// Runs the skill router when it is on. A failure warns and the run continues without it.
async function routeSkills(
  io: Io,
  mode: RouterMode,
  prompt: string,
  skills: Skill[],
  home: string,
  makeProvider: (name: string) => Provider,
): Promise<RouteResult | undefined> {
  if (mode === "off" || !skills.some((s) => s.modelInvocable)) return undefined;
  try {
    const embedModel = io.env.TEH_SKILL_ROUTER_EMBED_MODEL ?? DEFAULT_EMBED_MODEL;
    const confirmRef = io.env.TEH_SKILL_ROUTER_MODEL ? parseModelRef(io.env.TEH_SKILL_ROUTER_MODEL) : undefined;
    const router = new SkillRouter({
      mode,
      embedder: makeProvider("ollama"),
      embedModel,
      cacheFile: join(home, "cache", "skill-embeddings.json"),
      ...(io.env.TEH_SKILL_ROUTER_THRESHOLD ? { threshold: Number(io.env.TEH_SKILL_ROUTER_THRESHOLD) } : {}),
      ...(confirmRef ? { confirm: { provider: makeProvider(confirmRef.provider), model: confirmRef.model } } : {}),
    });
    const r = await router.route(prompt, skills);
    if (r.note) io.err(`teh: skill router: ${r.note}\n`);
    return r;
  } catch (e) {
    const hint = e instanceof ProviderError && e.hint ? ` (${e.hint})` : "";
    io.err(`teh: warning: skill router skipped: ${(e as Error).message}${hint}\n`);
    return undefined;
  }
}
