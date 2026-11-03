// Argument parsing and dispatch, kept free of process globals so it can be tested.
import { parseArgs } from "node:util";
import {
  type AgentEvent,
  builtinTools,
  createProvider,
  findProjectRoot,
  PERMISSION_MODES,
  type PermissionMode,
  type Provider,
  ProviderError,
  parseModelRef,
  parseRules,
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
};

export type Deps = { provider?: (name: string) => Provider };

export const USAGE = `Usage: teh -p [options] [prompt]
       teh models

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
  -v, --version                 Print the version
  -h, --help                    Show this help

Commands:
  models                        List local Ollama models and whether they support tools
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

    const session = new SessionLog(tehHome(io.env), findProjectRoot(io.cwd));
    const denied: string[] = [];
    const text = textOutput(io, denied);
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
      onEvent,
    });

    const isError = res.stopReason === "max_turns" || res.stopReason === "error";
    if (format === "text") {
      text.finish();
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
