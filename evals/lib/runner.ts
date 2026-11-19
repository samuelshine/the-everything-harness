// The shared eval runner: every task runs k times on every model through the real CLI
// (`teh -p`) in a fresh copy of its fixture, and a check reads what the run left behind.
// Results are saved after each trial, so an interrupted run resumes where it stopped.
//
// Each trial also writes OpenTelemetry spans (TEH_TRACE_FILE), from which the runner counts
// model requests, tool calls and failed tool calls. Cost comes from the CLI's own result
// (`total_cost_usd`), which is $0 for local models and the ChatGPT plan.
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { SpanRecord } from "../../packages/core/src/tracing";
import { meanOver, passAtK, passHatK, tally } from "./stats";

export type Trial = { dir: string; reply: string; stdout: string };

export type EvalTask = {
  id: string;
  prompt: string;
  // Files to create before the run, relative to the task folder.
  files: Record<string, string>;
  // Commands to run in the folder before the agent starts (after `git init` and a first commit).
  setup?: string[][];
  // Bash rules the agent may run without asking; edits are always allowed (acceptEdits).
  allow?: string[];
  check: (t: Trial) => Promise<boolean> | boolean;
};

export type TrialResult = {
  task: string;
  model: string;
  trial: number;
  pass: boolean;
  seconds: number;
  input: number;
  cachedRead: number;
  output: number;
  costUsd: number;
  turns: number;
  requests: number;
  toolCalls: number;
  toolErrors: number;
  stop: string;
  stderr?: string;
};

export type RunOptions = {
  name: string;
  tasks: EvalTask[];
  models: string[];
  trials: number;
  timeoutMs: number;
  outFile: string;
  // Extra environment for every trial.
  env?: Record<string, string>;
  // A settings.json copied into each trial's TEH_HOME, e.g. to define an OpenAI-compatible server.
  settingsFile?: string;
  log?: (line: string) => void;
};

const CLI = join(import.meta.dir, "..", "..", "packages", "cli", "src", "main.ts");

export function sh(dir: string, cmd: string[]): { ok: boolean; out: string } {
  try {
    const r = Bun.spawnSync(cmd, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString() + r.stderr.toString() };
  } catch (e) {
    // A program that does not exist (e.g. a script the agent never wrote).
    return { ok: false, out: (e as Error).message };
  }
}

export function readFile(dir: string, f: string): string {
  return existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "";
}

export function prepare(task: EvalTask): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `teh-eval-${task.id}-`)));
  for (const [f, text] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), text);
  }
  const git = (...a: string[]) => sh(dir, ["git", ...a]);
  git("init", "-q", "-b", "main");
  // A local identity, so setup commands and the agent can commit.
  git("config", "user.name", "eval");
  git("config", "user.email", "eval@example.com");
  git("add", "-A");
  git("commit", "-qm", "fixture", "--allow-empty");
  for (const cmd of task.setup ?? []) {
    const r = sh(dir, cmd);
    if (!r.ok) throw new Error(`${task.id}: setup ${cmd.join(" ")} failed: ${r.out}`);
  }
  return dir;
}

function spanCounts(file: string) {
  const c = { requests: 0, toolCalls: 0, toolErrors: 0 };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const s = JSON.parse(line) as SpanRecord;
    const op = s.attributes["gen_ai.operation.name"];
    if (op === "chat") c.requests++;
    if (op === "execute_tool") {
      c.toolCalls++;
      if (s.status === "error") c.toolErrors++;
    }
  }
  return c;
}

export async function runTrial(task: EvalTask, model: string, trial: number, o: RunOptions): Promise<TrialResult> {
  const dir = prepare(task);
  const home = join(dir, "..", `${dir.split("/").pop()}-home`);
  const traceFile = join(home, "trace.jsonl");
  mkdirSync(home, { recursive: true });
  if (o.settingsFile) copyFileSync(o.settingsFile, join(home, "settings.json"));
  const started = performance.now();
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI,
      "-p",
      "--model",
      model,
      "--output-format",
      "json",
      "--permission-mode",
      "acceptEdits",
      ...(task.allow?.length ? ["--allowedTools", ...task.allow] : []),
      "--",
      task.prompt,
    ],
    {
      cwd: dir,
      env: { ...process.env, TEH_HOME: home, ...o.env, TEH_TRACE_FILE: traceFile },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => proc.kill(), o.timeoutMs);
  // Both pipes are drained, or a chatty run blocks on a full stderr pipe.
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;
  clearTimeout(timer);
  const seconds = Math.round((performance.now() - started) / 100) / 10;
  let out: {
    result?: string;
    usage?: { input: number; cachedRead: number; output: number };
    num_turns?: number;
    stop_reason?: string;
    total_cost_usd?: number;
  } = {};
  try {
    out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
  } catch {
    out = { stop_reason: "no output" };
  }
  let pass = false;
  try {
    pass = await task.check({ dir, reply: out.result ?? "", stdout });
  } catch {}
  const counts = existsSync(traceFile) ? spanCounts(traceFile) : { requests: 0, toolCalls: 0, toolErrors: 0 };
  rmSync(dir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
  return {
    task: task.id,
    model,
    trial,
    pass,
    seconds,
    input: out.usage?.input ?? 0,
    cachedRead: out.usage?.cachedRead ?? 0,
    output: out.usage?.output ?? 0,
    costUsd: out.total_cost_usd ?? 0,
    turns: out.num_turns ?? 0,
    ...counts,
    stop: proc.signalCode ? `killed (${proc.signalCode})` : (out.stop_reason ?? "?"),
    ...(out.result === undefined ? { stderr: stderr.slice(-400) } : {}),
  };
}

export async function runEval(o: RunOptions): Promise<TrialResult[]> {
  const log = o.log ?? console.log;
  const results: TrialResult[] = existsSync(o.outFile) ? JSON.parse(readFileSync(o.outFile, "utf8")).results : [];
  const save = () => {
    mkdirSync(dirname(o.outFile), { recursive: true });
    writeFileSync(
      o.outFile,
      `${JSON.stringify({ eval: o.name, models: o.models, trials: o.trials, results }, null, 2)}\n`,
    );
  };
  // Grouped by model so a local model loads once.
  for (const model of o.models) {
    for (const task of o.tasks) {
      for (let trial = 1; trial <= o.trials; trial++) {
        if (results.some((r) => r.task === task.id && r.model === model && r.trial === trial)) continue;
        const r = await runTrial(task, model, trial, o);
        results.push(r);
        save();
        log(
          `${model} ${task.id} #${trial}: ${r.pass ? "pass" : "FAIL"} ${r.seconds}s ${r.turns} turns ${r.toolCalls} tools (${r.toolErrors} failed) ${r.stop}`,
        );
      }
    }
  }
  return results;
}

export type ModelSummary = {
  model: string;
  tasks: number;
  trials: number;
  passRate: number;
  passAt: Record<number, number | undefined>;
  passHat: Record<number, number | undefined>;
  medianSeconds: number;
  meanTurns: number;
  toolErrorRate: number;
  costUsd: number;
};

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
};

export function summarise(results: TrialResult[], model: string, ks: number[]): ModelSummary {
  const rs = results.filter((r) => r.model === model);
  const t = tally(rs);
  const calls = rs.reduce((n, r) => n + r.toolCalls, 0);
  return {
    model,
    tasks: t.length,
    trials: rs.length,
    passRate: rs.length ? rs.filter((r) => r.pass).length / rs.length : 0,
    passAt: Object.fromEntries(ks.map((k) => [k, meanOver(t, k, passAtK)])),
    passHat: Object.fromEntries(ks.map((k) => [k, meanOver(t, k, passHatK)])),
    medianSeconds: median(rs.map((r) => r.seconds)),
    meanTurns: rs.length ? rs.reduce((n, r) => n + r.turns, 0) / rs.length : 0,
    toolErrorRate: calls ? rs.reduce((n, r) => n + r.toolErrors, 0) / calls : 0,
    costUsd: rs.reduce((n, r) => n + r.costUsd, 0),
  };
}

const pct = (x: number | undefined) => (x === undefined ? "  -  " : `${(x * 100).toFixed(0).padStart(3)}%`);

// A plain-text report: one row per model, then one row per task with its passes per model.
export function report(results: TrialResult[], models: string[], trials: number): string {
  const ks = [1, ...(trials >= 3 ? [3] : []), ...(trials > 3 ? [trials] : trials === 2 ? [2] : [])];
  const lines: string[] = [];
  const head = ks.map((k) => `pass^${k}`.padStart(7)).join(" ");
  lines.push(`${"model".padEnd(32)} ${head}  pass@${ks.at(-1)}  med s  turns  tool err   cost`);
  for (const m of models) {
    const s = summarise(results, m, ks);
    lines.push(
      `${m.padEnd(32)} ${ks.map((k) => pct(s.passHat[k]).padStart(7)).join(" ")}  ${pct(s.passAt[ks.at(-1) as number]).padStart(6)}  ${String(s.medianSeconds).padStart(5)}  ${s.meanTurns.toFixed(1).padStart(5)}  ${pct(s.toolErrorRate).padStart(8)}  $${s.costUsd.toFixed(2)}`,
    );
  }
  lines.push("", `${"task".padEnd(24)} ${models.map((m) => m.slice(-14).padStart(14)).join(" ")}`);
  for (const task of [...new Set(results.map((r) => r.task))]) {
    const cells = models.map((m) => {
      const rs = results.filter((r) => r.task === task && r.model === m);
      return `${rs.filter((r) => r.pass).length}/${rs.length}`.padStart(14);
    });
    lines.push(`${task.padEnd(24)} ${cells.join(" ")}`);
  }
  return lines.join("\n");
}
