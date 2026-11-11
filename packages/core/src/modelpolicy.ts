// Model policy (ADR-0014): choosing a model when the person has not pinned one. The task is
// sorted into a tier by rules alone, so the choice costs no tokens, and it is made once, at
// the start of a session. Changing model mid-conversation would throw away the prompt cache
// and make the new model re-read the whole context.
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

// S takes the smallest capable model, L the largest, M the one in the middle.
export function chooseModel(models: ModelInfo[], tier: Tier): ModelInfo | undefined {
  const ranked = capableModels(models);
  if (!ranked.length) return undefined;
  const i = tier === "S" ? 0 : tier === "L" ? ranked.length - 1 : Math.floor(ranked.length / 2);
  return ranked[i];
}
