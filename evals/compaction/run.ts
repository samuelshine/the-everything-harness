// Compaction eval (ADR-0020): can a model finish a task that outgrows its context window,
// and keep facts from before each compaction?
//
//   bun evals/compaction/run.ts --model ollama:gemma4:e4b --runs 5 [--arms compact,off,wide] [--out name]
//
// The task reads a config file and six modules one at a time, then writes answer.txt with a
// secret from the first file and a tag from the end of each module. The modules are long, so
// with a 12k window the early ones must be compacted away before the end. Arms:
//   compact  12k window, automatic compaction on (the default)
//   off      12k window, "autoCompact": false
//   wide     64k window, nothing needs compacting: the control for the task itself
// Secrets and tags are drawn fresh for each run, so no run can pass from a stale file.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";

const { values: v } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    model: { type: "string" },
    runs: { type: "string" },
    arms: { type: "string" },
    out: { type: "string" },
    timeout: { type: "string" },
  },
});
const model = v.model ?? "ollama:gemma4:e4b";
const runs = Number(v.runs ?? 5);
const arms = (v.arms ?? "compact,off,wide").split(",");
const timeoutMs = Number(v.timeout ?? 600) * 1000;
const cli = join(import.meta.dir, "..", "..", "packages", "cli", "src", "main.ts");
const outFile = join(import.meta.dir, "results", `${v.out ?? "compaction"}.json`);

const ARMS: Record<string, { numCtx: number; autoCompact: boolean }> = {
  compact: { numCtx: 12_288, autoCompact: true },
  off: { numCtx: 12_288, autoCompact: false },
  wide: { numCtx: 65_536, autoCompact: true },
};

const WORDS = ["amber", "birch", "cobalt", "delta", "ember", "fjord", "garnet", "harbor", "indigo", "juniper", "kelp"];
const pick = <T>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)] as T;

function fixture(dir: string) {
  const secret = `${pick(WORDS)}-${1000 + Math.floor(Math.random() * 9000)}`;
  const tags: string[] = [];
  writeFileSync(join(dir, "config.py"), `SECRET_CODE = "${secret}"\n`);
  for (let m = 1; m <= 6; m++) {
    const tag = `${pick(WORDS)}${Math.floor(Math.random() * 100)}`;
    tags.push(tag);
    const lines = [`# module ${m}`];
    for (let k = 0; k < 120; k++)
      lines.push(`def f${k}_${m}(x):`, `    return x * ${1 + Math.floor(Math.random() * 99)}  # helper ${k}`);
    lines.push(`TAG = "${tag}"`);
    writeFileSync(join(dir, `mod${m}.py`), `${lines.join("\n")}\n`);
  }
  return { secret, tags };
}

const PROMPT =
  "Read config.py and note SECRET_CODE. Then read mod1.py, mod2.py, mod3.py, mod4.py, mod5.py and mod6.py one at a time with the Read tool; each ends with a TAG line, note each TAG. Finally write answer.txt with the secret code on the first line and the six tags, in module order, on the next six lines. Values only, no quotes.";

type Result = {
  arm: string;
  run: number;
  pass: boolean;
  secret: boolean;
  tags: number;
  compactions: number;
  seconds: number;
  input: number;
  output: number;
  stop: string;
};
const results: Result[] = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")).results : [];
const save = () => {
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, `${JSON.stringify({ model, runs, arms: ARMS, prompt: PROMPT, results }, null, 2)}\n`);
};

for (const arm of arms) {
  const cfg = ARMS[arm];
  if (!cfg) throw new Error(`unknown arm ${arm}`);
  for (let run = 1; run <= runs; run++) {
    if (results.some((r) => r.arm === arm && r.run === run)) continue;
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "teh-compact-")));
    const home = join(dir, ".teh-home");
    mkdirSync(home);
    if (!cfg.autoCompact) writeFileSync(join(home, "settings.json"), JSON.stringify({ autoCompact: false }));
    const truth = fixture(dir);
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
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
        "--",
        PROMPT,
      ],
      {
        cwd: dir,
        env: { ...process.env, TEH_HOME: home, TEH_OLLAMA_NUM_CTX: String(cfg.numCtx) },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    const [stdout] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    await proc.exited;
    clearTimeout(timer);
    const seconds = Math.round((performance.now() - started) / 100) / 10;
    let out: { usage?: { input: number; output: number }; stop_reason?: string } = {};
    try {
      out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}");
    } catch {
      out = { stop_reason: "no output" };
    }
    const answer = existsSync(join(dir, "answer.txt"))
      ? readFileSync(join(dir, "answer.txt"), "utf8")
          .split("\n")
          .map((l) => l.trim().replace(/^["']|["']$/g, ""))
          .filter(Boolean)
      : [];
    const secret = answer[0] === truth.secret;
    const tags = truth.tags.filter((t, i) => answer[i + 1] === t).length;
    const sessions = join(home, "projects");
    let compactions = 0;
    for (const f of new Bun.Glob("*/sessions/*.jsonl").scanSync({ cwd: sessions, absolute: true }))
      compactions += readFileSync(f, "utf8").split('"type":"compact"').length - 1;
    const r: Result = {
      arm,
      run,
      pass: secret && tags === 6,
      secret,
      tags,
      compactions,
      seconds,
      input: out.usage?.input ?? 0,
      output: out.usage?.output ?? 0,
      stop: proc.signalCode ? `killed (${proc.signalCode})` : (out.stop_reason ?? "?"),
    };
    results.push(r);
    save();
    console.log(
      `${arm} #${run}: ${r.pass ? "pass" : "FAIL"} secret=${secret} tags=${tags}/6 compactions=${compactions} ${seconds}s ${r.stop}`,
    );
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log("\narm       pass   secret  tags/6  compactions  s/run");
for (const arm of arms) {
  const rs = results.filter((r) => r.arm === arm);
  if (!rs.length) continue;
  const avg = (f: (r: Result) => number) => (rs.reduce((a, r) => a + f(r), 0) / rs.length).toFixed(1);
  console.log(
    `${arm.padEnd(9)} ${`${rs.filter((r) => r.pass).length}/${rs.length}`.padEnd(6)} ${`${rs.filter((r) => r.secret).length}/${rs.length}`.padEnd(7)} ${avg((r) => r.tags).padEnd(7)} ${avg((r) => r.compactions).padEnd(12)} ${avg((r) => r.seconds)}`,
  );
}
