// Skill router (ADR-0015): before the main model runs, shortlist the skills that look
// relevant to a prompt and tell the main model. It suggests; it never invokes a skill.
//   embed          — an embedding model ranks skill descriptions against the prompt
//   embed+confirm  — a small chat model then keeps or drops each shortlisted skill
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Provider } from "./providers/provider";
import type { Skill } from "./skills";

export const ROUTER_MODES = ["off", "embed", "embed+confirm"] as const;
export type RouterMode = (typeof ROUTER_MODES)[number];

export type RouteCandidate = { name: string; score: number };
export type RouteResult = {
  mode: RouterMode;
  // Embedding shortlist, best first.
  candidates: RouteCandidate[];
  // What the router suggests to the main model.
  chosen: string[];
  ms: number;
  note?: string;
};

export type RouterOptions = {
  mode: RouterMode;
  embedder: Provider;
  embedModel: string;
  confirm?: { provider: Provider; model: string };
  // Where description embeddings are cached between runs.
  cacheFile?: string;
  topK?: number;
  threshold?: number;
};

export const DEFAULT_EMBED_MODEL = "nomic-embed-text";
// Calibrated on evals/skill-routing with nomic-embed-text (see its README). Embeddings alone
// do best taking only the top match above 0.6; with a confirm model, a wider shortlist
// (top 3 above 0.55) finds more right skills and the small model removes the noise.
export const ROUTER_DEFAULTS = {
  embed: { threshold: 0.6, topK: 1 },
  "embed+confirm": { threshold: 0.55, topK: 3 },
} as const;

// nomic-embed models are trained with task prefixes; other models take plain text.
function prefixes(model: string) {
  return model.startsWith("nomic-embed")
    ? { query: "search_query: ", doc: "search_document: " }
    : { query: "", doc: "" };
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export class SkillRouter {
  private cache: Record<string, number[]> | undefined;

  constructor(private readonly opts: RouterOptions) {}

  private get defaults() {
    return this.opts.mode === "embed+confirm" ? ROUTER_DEFAULTS["embed+confirm"] : ROUTER_DEFAULTS.embed;
  }

  async route(prompt: string, skills: Skill[]): Promise<RouteResult> {
    const started = performance.now();
    const done = (r: Omit<RouteResult, "mode" | "ms">): RouteResult => ({
      mode: this.opts.mode,
      ms: Math.round(performance.now() - started),
      ...r,
    });
    const usable = skills.filter((s) => s.modelInvocable);
    if (this.opts.mode === "off" || usable.length === 0) return done({ candidates: [], chosen: [] });

    const candidates = await this.shortlist(prompt, usable);
    if (this.opts.mode === "embed" || candidates.length === 0) {
      return done({ candidates, chosen: candidates.map((c) => c.name) });
    }
    const confirmed = await this.confirm(prompt, candidates, usable);
    return done({ candidates, ...confirmed });
  }

  private async shortlist(prompt: string, skills: Skill[]): Promise<RouteCandidate[]> {
    const { embedder, embedModel } = this.opts;
    if (!embedder.embed) throw new Error(`provider ${embedder.id} cannot embed text`);
    const p = prefixes(embedModel);
    const cache = this.loadCache();
    const key = (s: Skill) =>
      createHash("sha256").update(`${embedModel}\0${s.name}\0${s.description}`).digest("hex").slice(0, 32);
    const missing = skills.filter((s) => !cache[key(s)]);
    if (missing.length) {
      const vectors = await embedder.embed(
        embedModel,
        missing.map((s) => `${p.doc}${s.name}: ${s.description}`),
      );
      for (const [i, s] of missing.entries()) if (vectors[i]) cache[key(s)] = vectors[i];
      this.saveCache();
    }
    const [query] = await embedder.embed(embedModel, [`${p.query}${prompt}`]);
    if (!query) return [];
    return skills
      .map((s) => ({ name: s.name, score: Number(cosine(query, cache[key(s)] ?? []).toFixed(3)) }))
      .filter((c) => c.score >= (this.opts.threshold ?? this.defaults.threshold))
      .sort((a, b) => b.score - a.score)
      .slice(0, this.opts.topK ?? this.defaults.topK);
  }

  private async confirm(
    prompt: string,
    candidates: RouteCandidate[],
    skills: Skill[],
  ): Promise<{ chosen: string[]; note?: string }> {
    const c = this.opts.confirm;
    if (!c) return { chosen: candidates.map((x) => x.name), note: "no confirm model set; used the shortlist" };
    const listed = candidates.map((x) => {
      const s = skills.find((k) => k.name === x.name);
      return `- ${x.name}: ${(s?.description ?? "").replace(/\s+/g, " ")}`;
    });
    let text = "";
    for await (const ev of c.provider.stream({
      model: c.model,
      system:
        'You decide which skills apply to a user\'s request. A skill applies only if the request clearly asks for what its description covers. Reply with JSON only, in the form {"skills": ["name"]}, or {"skills": []} if none apply.',
      items: [
        {
          kind: "text",
          role: "user",
          text: `Request:\n${prompt}\n\nCandidate skills:\n${listed.join("\n")}`,
        },
      ],
      tools: [],
      temperature: 0,
      json: true,
      maxOutputTokens: 120,
      contextTokens: 4096,
    })) {
      if (ev.type === "text_delta") text += ev.text;
    }
    const names = new Set(candidates.map((x) => x.name));
    try {
      const parsed = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)) as { skills?: unknown };
      if (!Array.isArray(parsed.skills)) throw new Error("no skills array");
      // Only shortlisted names count, so the small model cannot invent a skill.
      return { chosen: parsed.skills.map(String).filter((n) => names.has(n)) };
    } catch {
      return { chosen: candidates.map((x) => x.name), note: `confirm model gave no usable JSON; used the shortlist` };
    }
  }

  private loadCache(): Record<string, number[]> {
    if (this.cache) return this.cache;
    const f = this.opts.cacheFile;
    try {
      this.cache = f && existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as Record<string, number[]>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private saveCache() {
    const f = this.opts.cacheFile;
    if (!f || !this.cache) return;
    mkdirSync(dirname(f), { recursive: true, mode: 0o700 });
    writeFileSync(f, JSON.stringify(this.cache));
  }
}

// The note the main model sees, or undefined when nothing was chosen.
export function routerHint(r: RouteResult): string | undefined {
  if (r.chosen.length === 0) return undefined;
  return `(Skill router: these skills look relevant to this request: ${r.chosen.join(", ")}. If one fits, load it with the Skill tool before starting; otherwise ignore this note.)`;
}
