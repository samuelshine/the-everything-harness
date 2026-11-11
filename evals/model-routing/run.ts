// Model-routing eval (ADR-0014): does choosing a model per task beat always using one?
//
//   bun evals/model-routing/run.ts --models ollama:a,ollama:b,ollama:c --runs 3 [--tasks S1,M2] [--out name] [--save-scores]
//
// Every task runs k times on every listed model through the real CLI (`teh -p`). Because the
// automatic choice is a pure function of the prompt and the installed models, its outcome on a
// task is the outcome of the model it picks; the report reads that from the same runs.
// Local models cost no money, so "cost" here is wall time and tokens. --save-scores writes the
// per-tier pass rates to ~/.teh/model-scores.json, which teh then uses to choose models.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { chooseModel, createProvider, type ModelScores, type Tier, triage } from "../../packages/core/src/index";
import { FIXTURE, TASKS } from "./tasks";

const { values: v } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    models: { type: "string" },
    runs: { type: "string" },
    tasks: { type: "string" },
    out: { type: "string" },
    timeout: { type: "string" },
    "save-scores": { type: "boolean" },
  },
});
if (!v.models) throw new Error("--models ollama:a,ollama:b is required");
const models = v.models.split(",").map((m) => m.trim());
const runs = Number(v.runs ?? 3);
const timeoutMs = Number(v.timeout ?? 300) * 1000;
const tasks = v.tasks ? TASKS.filter((t) => v.tasks?.split(",").some((p) => t.id.startsWith(p))) : TASKS;
const cli = join(import.meta.dir, "..", "..", "packages", "cli", "src", "main.ts");
const outFile = join(import.meta.dir, "results", `${v.out ?? "routing"}.json`);

type Result = {
  task: string;
  model: string;
  run: number;
  pass: boolean;
  seconds: number;
  input: number;
  output: number;
  turns: number;
  stop: string;
  stderr?: string;
};
const results: Result[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")).results : [];
const save = () => {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ models, runs, results }, null, 2)}\n`);
};

const template = realpathSync(mkdtempSync(join(tmpdir(), "teh-route-fixture-")));
for (const [f, text] of Object.entries(FIXTURE)) {
  mkdirSync(dirname(join(template, f)), { recursive: true });
  writeFileSync(join(template, f), text);
}
Bun.spawnSync(["git", "init", "-q"], { cwd: template });

// Grouped by model so each model loads once.
for (const model of models) {
  for (const task of tasks) {
    for (let run = 1; run <= runs; run++) {
      if (results.some((r) => r.task === task.id && r.model === model && r.run === run)) continue;
      const dir = realpathSync(mkdtempSync(join(tmpdir(), "teh-route-")));
      cpSync(template, dir, { recursive: true });
      const home = join(dir, ".teh-home");
      const started = performance.now();
      const proc = Bun.spawn(
        [
          process.execPath,
          cli,
          "-p",
          "--model",
          model,
          "--output-format",
          "json",
          "--permission-mode",
          "acceptEdits",
          "--allowedTools",
          "Bash(bun test:*)",
          "Bash(bun cli.js:*)",
          "Bash(bun run:*)",
          "Bash(node:*)",
          "--",
          task.prompt,
        ],
        { cwd: dir, env: { ...process.env, TEH_HOME: home }, stdout: "pipe", stderr: "pipe" },
      );
      const timer = setTimeout(() => proc.kill(), timeoutMs);
      // Both pipes are drained, or a chatty run blocks on a full stderr pipe.
      const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
      await proc.exited;
      clearTimeout(timer);
      const seconds = Math.round((performance.now() - started) / 100) / 10;
      let out: {
        result?: string;
        usage?: { input: number; output: number };
        num_turns?: number;
        stop_reason?: string;
      } = {};
      try {
        out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
      } catch {
        out = { stop_reason: "no output" };
      }
      const pass = await task.check({ dir, reply: out.result ?? "" }).catch(() => false);
      const r: Result = {
        task: task.id,
        model,
        run,
        pass,
        seconds,
        input: out.usage?.input ?? 0,
        output: out.usage?.output ?? 0,
        turns: out.num_turns ?? 0,
        stop: proc.signalCode ? `killed (${proc.signalCode})` : (out.stop_reason ?? "?"),
        ...(out.result === undefined ? { stderr: stderr.slice(-400) } : {}),
      };
      results.push(r);
      save();
      console.log(
        `${model} ${task.id} #${run}: ${pass ? "pass" : "FAIL"} ${seconds}s ${r.input}+${r.output} tok ${r.stop}`,
      );
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

// --- Report ----------------------------------------------------------------------------
// Per-model, per-tier scores from a set of results.
function scoresFrom(rs: Result[]): ModelScores {
  const out: ModelScores = {};
  for (const m of models) {
    for (const tier of ["S", "M", "L"] as Tier[]) {
      const mine = rs.filter((r) => r.model === m && triage(taskById(r.task).prompt).tier === tier);
      if (!mine.length) continue;
      out[m] = {
        ...out[m],
        [tier]: {
          pass: mine.filter((r) => r.pass).length / mine.length,
          runs: mine.length,
          seconds: Math.round((mine.reduce((a, r) => a + r.seconds, 0) / mine.length) * 10) / 10,
        },
      };
    }
  }
  return out;
}
const taskById = (id: string) => TASKS.find((t) => t.id === id) as (typeof TASKS)[number];

const installed = await createProvider("ollama").listModels();
const listed = installed.filter((m) => models.includes(`ollama:${m.id}`));
const tierOf = (t: string) => triage(taskById(t).prompt).tier;
// By size, as teh did before measured scores (no scores given).
const bySize = (t: string) => `ollama:${chooseModel(listed, tierOf(t), {})?.model.id}`;
// By measured score, leaving the task out of the scores it is chosen with, so no task is
// graded with a choice its own runs informed.
const byScore = (t: string) =>
  `ollama:${chooseModel(listed, tierOf(t), scoresFrom(results.filter((r) => r.task !== t)))?.model.id}`;
const rows = (pick: (task: string) => string) =>
  tasks.flatMap((t) => results.filter((r) => r.task === t.id && r.model === pick(t.id)));
const line = (name: string, rs: Result[]) => {
  const n = rs.length || 1;
  const passed = rs.filter((r) => r.pass).length;
  const secs = rs.reduce((a, r) => a + r.seconds, 0);
  const tok = rs.reduce((a, r) => a + r.input + r.output, 0);
  return {
    config: name,
    runs: rs.length,
    passRate: `${Math.round((passed / n) * 100)}%`,
    meanSeconds: Math.round(secs / n),
    meanTokens: Math.round(tok / n),
    passesPerHour: Math.round((passed / Math.max(1, secs)) * 3600 * 10) / 10,
    passesPer100kTokens: Math.round((passed / Math.max(1, tok)) * 100_000 * 10) / 10,
  };
};
const table = [
  ...models.map((m) =>
    line(
      m,
      rows(() => m),
    ),
  ),
  line("auto by size", rows(bySize)),
  line("auto by measured score", rows(byScore)),
];
console.table(table);
const perTask = tasks.map((t) => ({
  task: t.id,
  tier: tierOf(t.id),
  bySize: bySize(t.id),
  byScore: byScore(t.id),
  ...Object.fromEntries(
    models.map((m) => {
      const rs = results.filter((r) => r.task === t.id && r.model === m);
      return [m, `${rs.filter((r) => r.pass).length}/${rs.length}`];
    }),
  ),
}));
console.table(perTask);
const scores = scoresFrom(results);
writeFileSync(outFile, `${JSON.stringify({ models, runs, scores, summary: table, perTask, results }, null, 2)}\n`);
if (v["save-scores"]) {
  const home = process.env.TEH_HOME || join(homedir(), ".teh");
  mkdirSync(home, { recursive: true });
  writeFileSync(
    join(home, "model-scores.json"),
    `${JSON.stringify({ measured: new Date().toISOString(), models: scores }, null, 2)}\n`,
  );
  console.log(`Saved scores to ${join(home, "model-scores.json")}; teh now chooses models with them.`);
}
rmSync(template, { recursive: true, force: true });
