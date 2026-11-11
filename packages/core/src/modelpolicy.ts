// Model policy (ADR-0014): choosing a model when the person has not pinned one. The task is
// sorted into a tier by rules alone, so the choice costs no tokens, and it is made once, at
// the start of a session. Changing model mid-conversation would throw away the prompt cache
// and make the new model re-read the whole context.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ModelInfo } from "./providers/provider";

export type Tier = "S" | "M" | "L";
export type Triage = { tier: Tier; rule: string; reason: string };

const LARGE =
  /\b(refactor|re-?architect|architecture|migrat(e|ion)|redesign|rewrite|overhaul|design|implement|build|port|debug|race condition|deadlock|memory leak|performance|optimi[sz]e|security|concurren(t|cy)|across the (repo|codebase|project)|whole (repo|codebase|project)|entire (repo|codebase|project)|end[- ]to[- ]end)\b/i;
const SMALL =
  /^(what|why|how|where|when|which|who|is|are|does|do|can|explain|show|list|summari[sz]e|describe|tell me)\b|\b(typo|rename|spelling|comment|docstring|format|lint|bump|changelog|commit message)\b/i;

export function triage(prompt: string, opts: { planMode?: boolean } = {}): Triage {
  const text = prompt.trim();
  const words = text ? text.split(/\s+/).length : 0;
  const files = (text.match(/[\w./-]+\.[a-z]{1,5}\b/gi) ?? []).length;
  if (opts.planMode) return { tier: "L", rule: "plan-mode", reason: "plan mode" };
  if (!text) return { tier: "M", rule: "no-task", reason: "no task yet" };
  if (words > 250) return { tier: "L", rule: "long-prompt", reason: `long prompt (${words} words)` };
  if (files >= 4) return { tier: "L", rule: "many-files", reason: `${files} files named` };
  const large = text.match(LARGE);
  if (large) return { tier: "L", rule: "keyword-large", reason: `"${large[0].toLowerCase()}"` };
  if (words <= 40 && SMALL.test(text)) {
    return { tier: "S", rule: "small-ask", reason: text.includes("?") ? "short question" : "small change" };
  }
  if (words <= 6) return { tier: "S", rule: "very-short", reason: "very short prompt" };
  return { tier: "M", rule: "default", reason: "ordinary task" };
}

// The models that can run the agent, smallest first.
// Models under about 2 GB call tools too unreliably to drive the agent, so they are used
// only when nothing larger is installed.
const MIN_AGENT_BYTES = 2e9;

export function capableModels(models: ModelInfo[]): ModelInfo[] {
  const tools = models.filter((m) => m.supportsTools);
  const sturdy = tools.filter((m) => m.sizeBytes === undefined || m.sizeBytes >= MIN_AGENT_BYTES);
  return (sturdy.length ? sturdy : tools).sort(
    (a, b) => (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0) || a.id.localeCompare(b.id),
  );
}

// How a model did on the model-routing eval (evals/model-routing) for tasks of one tier.
export type TierScore = { pass: number; runs: number; seconds: number };
// Keyed by "provider:model", then by tier.
export type ModelScores = Record<string, Partial<Record<Tier, TierScore>>>;

// Measured with evals/model-routing on 2026-11-11 (MacBook, 24 GiB, Ollama; 3 runs of each
// task: 3 tasks for S and M, 2 for L). Your own runs, saved with --save-scores to ~/.teh/model-scores.json, replace these.
export const MEASURED_SCORES: ModelScores = {
  "ollama:gemma4:e4b": {
    S: { pass: 1, runs: 9, seconds: 16 },
    M: { pass: 0.89, runs: 9, seconds: 30.6 },
    L: { pass: 1, runs: 6, seconds: 27.9 },
  },
  "ollama:qwen2.5:14b": {
    S: { pass: 0.78, runs: 9, seconds: 61.3 },
    M: { pass: 0.67, runs: 9, seconds: 86.2 },
    L: { pass: 0.83, runs: 6, seconds: 50.8 },
  },
  "ollama:mistral-nemo:12b": {
    S: { pass: 0.22, runs: 9, seconds: 5.6 },
    M: { pass: 0, runs: 9, seconds: 20.3 },
    L: { pass: 0, runs: 6, seconds: 12.4 },
  },
};

// A model is "as good" as the best when its pass rate is within this of the best's (ADR-0014).
const PASS_MARGIN = 0.02;
const MIN_RUNS = 3;

export type ModelChoice = { model: ModelInfo; basis: "measured" | "size" };

// The model for a task of this tier. Among installed models with eval results for the tier,
// the fastest one whose pass rate is within 2 points of the best. With no results, by size:
// S the smallest capable model, L the largest, M the middle one.
export function chooseModel(
  models: ModelInfo[],
  tier: Tier,
  scores: ModelScores = MEASURED_SCORES,
  provider = "ollama",
): ModelChoice | undefined {
  const ranked = capableModels(models);
  if (!ranked.length) return undefined;
  const measured = ranked.flatMap((m) => {
    const sc = scores[`${provider}:${m.id}`]?.[tier];
    return sc && sc.runs >= MIN_RUNS ? [{ m, sc }] : [];
  });
  if (measured.length) {
    const best = Math.max(...measured.map((x) => x.sc.pass));
    const good = measured.filter((x) => x.sc.pass >= best - PASS_MARGIN);
    good.sort((a, b) => a.sc.seconds - b.sc.seconds || b.sc.pass - a.sc.pass);
    return { model: (good[0] as { m: ModelInfo }).m, basis: "measured" };
  }
  const i = tier === "S" ? 0 : tier === "L" ? ranked.length - 1 : Math.floor(ranked.length / 2);
  return { model: ranked[i] as ModelInfo, basis: "size" };
}

// Built-in scores with the person's own (~/.teh/model-scores.json) laid over them.
export function loadModelScores(tehHome: string): ModelScores {
  const merged: ModelScores = structuredClone(MEASURED_SCORES);
  try {
    const own = JSON.parse(readFileSync(join(tehHome, "model-scores.json"), "utf8")) as { models?: ModelScores };
    for (const [model, tiers] of Object.entries(own.models ?? {})) merged[model] = { ...merged[model], ...tiers };
  } catch {
    // None saved, or unreadable: the built-in scores stand.
  }
  return merged;
}
