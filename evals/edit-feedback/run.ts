// Edit-feedback eval: does a model wreck a file and then report success?
//
//   bun evals/edit-feedback/run.ts --model ollama:gemma4:e4b --runs 20 [--cli path/to/main.ts] [--label x]
//
// Each run starts from a fresh two-file repo ("math.js" exports add) and asks for a subtract
// function. A run is graded from the file it leaves and its session log:
//   correct          add is still exported and a new function was added
//   damagingEdit     the first Edit of math.js replaced add instead of adding next to it
//   repaired         a damaging edit was followed by another change to math.js
//   falseSuccess     the file lost add, yet the run ended normally with a reply
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values: v } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string" },
    runs: { type: "string" },
    cli: { type: "string" },
    label: { type: "string" },
    prompt: { type: "string" },
  },
});
if (!v.model) throw new Error("--model provider:model is required");
const runs = Number(v.runs ?? 10);
const cli = v.cli ?? join(import.meta.dir, "..", "..", "packages", "cli", "src", "main.ts");
const prompt = v.prompt ?? "Add a subtract function to math.js.";
const ORIGINAL = "export const add = (a, b) => a + b;\n";

type Call = { name: string; args: Record<string, string> };
type Outcome = {
  run: number;
  correct: boolean;
  edited: boolean;
  damagingEdit: boolean;
  repaired: boolean;
  falseSuccess: boolean;
  file: string;
  reply: string;
};

const sh = (cmd: string[], cwd: string) => Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });

function sessionCalls(tehHome: string): Call[] {
  const projects = join(tehHome, "projects");
  const calls: Call[] = [];
  for (const p of readdirSync(projects)) {
    const dir = join(projects, p, "sessions");
    for (const f of readdirSync(dir)) {
      for (const line of readFileSync(join(dir, f), "utf8").split("\n")) {
        if (!line.includes('"type":"tool_call"')) continue;
        const d = JSON.parse(line).data;
        calls.push({ name: d.name, args: typeof d.args === "string" ? JSON.parse(d.args) : d.args });
      }
    }
  }
  return calls;
}

const outcomes: Outcome[] = [];
for (let run = 1; run <= runs; run++) {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "teh-edit-eval-")));
  const tehHome = join(repo, ".teh-home");
  writeFileSync(join(repo, "math.js"), ORIGINAL);
  writeFileSync(join(repo, "package.json"), '{"name":"demo","type":"module"}\n');
  sh(["git", "init", "-q"], repo);
  const r = Bun.spawnSync(["bun", cli, "-p", "--model", v.model, "--permission-mode", "acceptEdits", prompt], {
    cwd: repo,
    env: { ...process.env, TEH_HOME: tehHome },
    stdout: "pipe",
    stderr: "pipe",
  });
  const reply = r.stdout.toString().trim();
  const file = readFileSync(join(repo, "math.js"), "utf8");
  const calls = sessionCalls(tehHome);
  const onMath = (c: Call) =>
    (c.name === "Edit" || c.name === "Write") && String(c.args.file_path ?? "").endsWith("math.js");
  const first = calls.findIndex((c) => c.name === "Edit" && onMath(c));
  const firstArgs = first >= 0 ? (calls[first] as Call).args : undefined;
  const damagingEdit =
    !!firstArgs && firstArgs.old_string?.includes("add =") === true && !firstArgs.new_string?.includes("add =");
  const keptAdd = file.includes("add = (a, b) => a + b");
  const outcome: Outcome = {
    run,
    correct: keptAdd && file.trim() !== ORIGINAL.trim(),
    edited: calls.some(onMath),
    damagingEdit,
    repaired: damagingEdit && calls.slice(first + 1).some(onMath),
    falseSuccess: !keptAdd && r.exitCode === 0 && reply.length > 0,
    file,
    reply,
  };
  outcomes.push(outcome);
  console.log(`${run}/${runs} correct=${outcome.correct} damaging=${damagingEdit} repaired=${outcome.repaired}`);
}

const count = (k: keyof Outcome) => outcomes.filter((o) => o[k] === true).length;
const summary = {
  model: v.model,
  prompt,
  runs,
  correct: count("correct"),
  noEdit: outcomes.filter((o) => !o.edited).length,
  damagingFirstEdit: count("damagingEdit"),
  repaired: count("repaired"),
  falseSuccess: count("falseSuccess"),
};
console.table([summary]);
const label = v.label ?? v.model.replace(/[:/]/g, "-");
mkdirSync(join(import.meta.dir, "results"), { recursive: true });
writeFileSync(join(import.meta.dir, "results", `${label}.json`), `${JSON.stringify({ summary, outcomes }, null, 1)}\n`);
