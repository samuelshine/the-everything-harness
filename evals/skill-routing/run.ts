// Skill-routing eval (ADR-0015). Measures whether the right skill gets picked.
//
//   bun evals/skill-routing/run.ts router [--confirm ollama:qwen2.5:0.5b] [--threshold 0.5]
//     The router alone: an embedding threshold sweep, or embed+confirm with a small model.
//   bun evals/skill-routing/run.ts agent --main ollama:gemma4:e4b [--router off|embed|embed+confirm]
//     The main model's first turn: does it call the Skill tool with the expected skill?
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  builtinTools,
  createProvider,
  DEFAULT_EMBED_MODEL,
  loadSkills,
  parseModelRef,
  type RouteResult,
  type RouterMode,
  runAgent,
  SkillRouter,
} from "../../packages/core/src/index";

type Case = { prompt: string; expected: string | null };
type Outcome = { prompt: string; expected: string | null; picked: string[]; ms: number; scores?: unknown };

const here = import.meta.dir;
const cases = JSON.parse(readFileSync(join(here, "cases.json"), "utf8")) as Case[];
// The fixture skills in evals/skill-routing/skills, loaded the way ~/.teh/skills would be.
const allSkills = loadSkills(here, join(here, "no-project"), join(here, "no-home")).skills;

const { values: v, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    main: { type: "string" },
    router: { type: "string" },
    confirm: { type: "string" },
    threshold: { type: "string" },
    label: { type: "string" },
  },
});
const stage = positionals[0];
const threshold = v.threshold ? Number(v.threshold) : undefined;
const ollama = createProvider("ollama", process.env);
const cacheFile = join(here, ".cache", "embeddings.json");

function score(outcomes: Outcome[]) {
  const pos = outcomes.filter((o) => o.expected);
  const neg = outcomes.filter((o) => !o.expected);
  const hit = pos.filter((o) => o.picked.includes(o.expected as string)).length;
  const exact = outcomes.filter((o) =>
    o.expected ? o.picked.length === 1 && o.picked[0] === o.expected : o.picked.length === 0,
  ).length;
  const falseAlarm = neg.filter((o) => o.picked.length > 0).length;
  const extra = pos.filter((o) => o.picked.some((p) => p !== o.expected)).length;
  const ms = outcomes.reduce((a, o) => a + o.ms, 0) / outcomes.length;
  return {
    recall: `${hit}/${pos.length}`,
    exact: `${exact}/${outcomes.length}`,
    falseAlarms: `${falseAlarm}/${neg.length}`,
    withWrongExtra: `${extra}/${pos.length}`,
    avgMs: Math.round(ms),
  };
}

function save(label: string, data: unknown) {
  mkdirSync(join(here, "results"), { recursive: true });
  const file = join(here, "results", `${label}.json`);
  writeFileSync(file, `${JSON.stringify(data, null, 1)}\n`);
  console.log(`saved ${file}`);
}

async function routerStage() {
  if (!v.confirm) {
    // One pass with threshold 0 records every score; thresholds are then applied offline.
    const router = new SkillRouter({
      mode: "embed",
      embedder: ollama,
      embedModel: DEFAULT_EMBED_MODEL,
      cacheFile,
      threshold: -1,
      topK: 12,
    });
    const raw: (Outcome & { route: RouteResult })[] = [];
    for (const c of cases) {
      const route = await router.route(c.prompt, allSkills);
      raw.push({ ...c, picked: [], ms: route.ms, route });
    }
    const rows = [];
    for (const t of [0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7]) {
      for (const k of [1, 3]) {
        const outcomes = raw.map((o) => ({
          ...o,
          picked: o.route.candidates
            .filter((c) => c.score >= t)
            .slice(0, k)
            .map((c) => c.name),
        }));
        rows.push({ threshold: t, topK: k, ...score(outcomes) });
      }
    }
    console.table(rows);
    save(v.label ?? "router-embed", {
      embedModel: DEFAULT_EMBED_MODEL,
      rows,
      cases: raw.map(({ route, ...o }) => ({ ...o, scores: route.candidates })),
    });
    return;
  }
  const ref = parseModelRef(v.confirm);
  const router = new SkillRouter({
    mode: "embed+confirm",
    embedder: ollama,
    embedModel: DEFAULT_EMBED_MODEL,
    cacheFile,
    ...(threshold !== undefined ? { threshold } : {}),
    confirm: { provider: createProvider(ref.provider, process.env), model: ref.model },
  });
  const outcomes: Outcome[] = [];
  let fallbacks = 0;
  for (const c of cases) {
    const r = await router.route(c.prompt, allSkills);
    if (r.note) fallbacks++;
    outcomes.push({ ...c, picked: r.chosen, ms: r.ms, scores: r.candidates });
  }
  const summary = { confirm: v.confirm, threshold: threshold ?? "default", fallbacks, ...score(outcomes) };
  console.table([summary]);
  save(v.label ?? `router-confirm-${ref.model.replace(/[:/]/g, "-")}`, { summary, outcomes });
}

async function agentStage() {
  if (!v.main) throw new Error("agent stage needs --main provider:model");
  const ref = parseModelRef(v.main);
  const provider = createProvider(ref.provider, process.env);
  const mode = (v.router ?? "off") as RouterMode;
  const confirmRef = v.confirm ? parseModelRef(v.confirm) : undefined;
  const router = new SkillRouter({
    mode,
    embedder: ollama,
    embedModel: DEFAULT_EMBED_MODEL,
    cacheFile,
    ...(threshold !== undefined ? { threshold } : {}),
    ...(confirmRef
      ? { confirm: { provider: createProvider(confirmRef.provider, process.env), model: confirmRef.model } }
      : {}),
  });
  const cwd = join(tmpdir(), "teh-skill-eval");
  mkdirSync(cwd, { recursive: true });
  const outcomes: Outcome[] = [];
  for (const [i, c] of cases.entries()) {
    const started = performance.now();
    const route = mode === "off" ? undefined : await router.route(c.prompt, allSkills);
    const res = await runAgent({
      provider,
      model: ref.model,
      prompt: c.prompt,
      cwd,
      tools: builtinTools,
      permissions: { mode: "plan", allow: [], deny: [] },
      ask: async () => false,
      skills: allSkills,
      maxTurns: 1,
      ...(route ? { skillRoute: route } : {}),
    });
    const picked = res.items.flatMap((it) =>
      it.kind === "tool_call" && it.name === "Skill" ? [String((it.args as { name?: unknown }).name)] : [],
    );
    outcomes.push({
      ...c,
      picked,
      ms: Math.round(performance.now() - started),
      ...(route ? { scores: route.chosen } : {}),
    });
    console.log(`${i + 1}/${cases.length} ${c.expected ?? "-"} → ${picked.join(",") || "-"}`);
  }
  const summary = {
    main: v.main,
    router: mode,
    confirm: v.confirm ?? null,
    threshold: threshold ?? "default",
    ...score(outcomes),
  };
  console.table([summary]);
  save(v.label ?? `agent-${ref.model.replace(/[:/]/g, "-")}-${mode.replace("+", "-")}`, { summary, outcomes });
}

if (stage === "router") await routerStage();
else if (stage === "agent") await agentStage();
else console.log("usage: bun evals/skill-routing/run.ts router|agent [options]");
