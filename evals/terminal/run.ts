// Terminal task eval (M2): Terminal-Bench-style jobs run k times per model through `teh -p`,
// reported as pass^k (does it work every time?) alongside pass@k, time, turns, tool errors
// and cost. See README.md.
//
//   bun evals/terminal/run.ts --models ollama:qwen2.5:14b,anthropic:claude-haiku-5-5 --trials 3 [--tasks fix,csv] [--settings file.json] [--out name]
import { join } from "node:path";
import { parseArgs } from "node:util";
import { report, runEval } from "../lib/runner";
import { TASKS } from "./tasks";

const { values: v } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    models: { type: "string" },
    trials: { type: "string" },
    tasks: { type: "string" },
    out: { type: "string" },
    timeout: { type: "string" },
    settings: { type: "string" },
  },
});
if (!v.models) throw new Error("--models ollama:a,anthropic:b is required");
const models = v.models.split(",").map((m) => m.trim());
const trials = Number(v.trials ?? 3);
const tasks = v.tasks ? TASKS.filter((t) => v.tasks?.split(",").some((p) => t.id.startsWith(p))) : TASKS;
const outFile = join(import.meta.dir, "results", `${v.out ?? "terminal"}.json`);

const results = await runEval({
  name: "terminal",
  tasks,
  models,
  trials,
  timeoutMs: Number(v.timeout ?? 300) * 1000,
  outFile,
  // Provider settings, e.g. an OpenAI-compatible server under "providers".
  ...(v.settings ? { settingsFile: v.settings } : {}),
});
console.log(`\n${report(results, models, trials)}\n\nresults: ${outFile}`);
