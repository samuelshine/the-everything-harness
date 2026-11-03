// Argument parsing and dispatch, kept free of process globals so it can be tested.
import { parseArgs } from "node:util";
import {
  type AgentEvent,
  builtinTools,
  type Checkpoint,
  CheckpointError,
  CheckpointStore,
  createProvider,
  findProjectRoot,
  PERMISSION_MODES,
  type PermissionMode,
  type Provider,
  ProviderError,
  parseModelRef,
  parseRules,
  type RestorePlan,
  runAgent,
  SessionLog,
  tehHome,
  VERSION,
} from "@everything-harness/core";

export type Io = {
  out: (s: string) => void;
  err: (s: string) => void;
  env: Record<string, string | undefined>;
  cwd: string;
  // Piped stdin, or undefined when stdin is a terminal.
  stdin: () => Promise<string | undefined>;
  // Ask the person a yes/no question; undefined when there is no terminal to ask on.
  confirm?: (question: string) => Promise<boolean>;
};

export type Deps = { provider?: (name: string) => Provider };

export const USAGE = `Usage: teh -p [options] [prompt]
       teh models
       teh checkpoints | teh undo | teh restore <id>

Run one prompt headlessly and print the result. The prompt can also be piped on stdin.
The interactive terminal UI is not built yet.

Options:
  -p, --print                   Run headlessly (required for now)
  --model <provider:model>      Model to use, e.g. ollama:qwen2.5:14b (or set TEH_MODEL)
  --output-format <format>      text (default), json or stream-json
  --permission-mode <mode>      default (ask; denied when headless), acceptEdits, plan, bypassPermissions
  --allowedTools <rules...>     Allow without asking, e.g. "Edit" "Bash(npm test)"
  --disallowedTools <rules...>  Always deny, e.g. "Bash"
  --add-dir <dir...>            Extra directories the agent may change
  --max-turns <n>               Stop after n model turns (default 50)
  -y, --yes                     Restore without asking (undo, restore)
  -v, --version                 Print the version
  -h, --help                    Show this help

Commands:
  models                        List local Ollama models and whether they support tools
  checkpoints                   List file snapshots taken before each run changed anything
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
  if (positionals[0] === "undo") return restore(io, undefined, v.yes ?? false);
  if (positionals[0] === "restore") {
    if (!positionals[1]) return usageError(io, "restore needs a checkpoint id; `teh checkpoints` lists them");
    return restore(io, positionals[1], v.yes ?? false);
  }
  if (v.help || (!v.print && positionals.length === 0)) {
    io.out(USAGE);
    return 0;
  }
  if (!v.print) {
    io.err("teh: the interactive UI is not built yet; use -p to run headlessly\n");
    return 2;
  }

  const format = (v["output-format"] ?? "text") as OutputFormat;
  if (!OUTPUT_FORMATS.includes(format))
    return usageError(io, `--output-format must be one of ${OUTPUT_FORMATS.join(", ")}`);
  const mode = (v["permission-mode"] ?? "default") as PermissionMode;
  if (!PERMISSION_MODES.includes(mode))
    return usageError(io, `--permission-mode must be one of ${PERMISSION_MODES.join(", ")}`);
  const maxTurns = v["max-turns"] === undefined ? 50 : Number(v["max-turns"]);
  if (!Number.isInteger(maxTurns) || maxTurns < 1) return usageError(io, "--max-turns must be a positive integer");

  const prompt = positionals.join(" ").trim() || (await io.stdin())?.trim();
  if (!prompt) return usageError(io, "no prompt given");

  const modelSpec = v.model ?? io.env.TEH_MODEL;
  if (!modelSpec) {
    io.err(
      "teh: no model selected\n  fix: pass --model ollama:<name> or set TEH_MODEL; `teh models` lists local models\n",
    );
    return 2;
  }

  const started = performance.now();
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

    const root = findProjectRoot(io.cwd);
    const session = new SessionLog(tehHome(io.env), root);
    const store = new CheckpointStore(tehHome(io.env), root);
    const denied: string[] = [];
    const text = textOutput(io, denied);
    const checkpoint = { taken: false };
    const onEvent = format === "stream-json" ? streamJson(io) : format === "text" ? text.onEvent : trackDenied(denied);
    if (format === "stream-json") {
      io.out(
        `${JSON.stringify({ type: "system", subtype: "init", session_id: session.id, model: modelSpec, cwd: io.cwd, tools: builtinTools.map((t) => t.spec.name), permission_mode: mode })}\n`,
      );
    }

    const res = await runAgent({
      provider,
      model: ref.model,
      prompt,
      cwd: io.cwd,
      tools: builtinTools,
      permissions: { mode, allow: parseRules(v.allowedTools ?? []), deny: parseRules(v.disallowedTools ?? []) },
      // Headless runs cannot ask, so anything that needs approval is denied (ADR-0008).
      ask: async () => false,
      addDirs: v["add-dir"] ?? [],
      session,
      maxTurns,
      onEvent: (e) => {
        if (e.type === "checkpoint") checkpoint.taken = true;
        onEvent(e);
      },
      checkpoint: async () => (await store.snapshot("turn", session.id, prompt)).sha,
    });

    const isError = res.stopReason === "max_turns" || res.stopReason === "error";
    if (format === "text") {
      text.finish();
      if (checkpoint.taken) io.err(`teh: \`teh undo\` reverts this run's file changes\n`);
      if (res.stopReason === "max_turns") io.err(`teh: stopped after ${maxTurns} turns (--max-turns)\n`);
      if (denied.length) {
        io.err(
          `teh: ${denied.length} action(s) needed approval and were denied. To allow them, re-run with\n` +
            `  --permission-mode acceptEdits   (file edits in this project), and/or\n` +
            `  --allowedTools "Bash(<exact command>)"\n`,
        );
      }
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
          denied_actions: denied,
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
function textOutput(io: Io, denied: string[]) {
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
      denied.push(e.summary);
      io.err(`✗ denied: ${e.summary} (${e.reason})\n`);
    } else if (e.type === "warning") {
      io.err(`teh: warning: ${e.message}\n`);
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

function trackDenied(denied: string[]) {
  return (e: AgentEvent) => {
    if (e.type === "approval" && e.behavior === "deny") denied.push(e.summary);
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
    const kind = c.kind === "restore" ? "before restore" : "before run";
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
