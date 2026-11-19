// Refreshes src/providers/registry-snapshot.json from models.dev (ADR-0002, capability registry).
// Run: bun packages/core/scripts/update-model-registry.ts [path/to/api.json]
// With no path it downloads https://models.dev/api.json.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const PROVIDERS = ["anthropic", "openai"];
type Raw = {
  limit?: { context?: number; input?: number; output?: number };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  modalities?: { input?: string[] };
  reasoning?: boolean;
  tool_call?: boolean;
  release_date?: string;
};

const src = process.argv[2];
const data = (src ? await Bun.file(src).json() : await (await fetch("https://models.dev/api.json")).json()) as Record<
  string,
  { models: Record<string, Raw> }
>;
const out: Record<string, Record<string, unknown>> = {};
for (const p of PROVIDERS) {
  for (const [id, m] of Object.entries(data[p]?.models ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    if (!m.tool_call) continue;
    out[`${p}:${id}`] = {
      context: m.limit?.input ?? m.limit?.context,
      output: m.limit?.output,
      vision: m.modalities?.input?.includes("image") ?? false,
      reasoning: m.reasoning ?? false,
      released: m.release_date,
      ...(m.cost
        ? {
            cost: {
              input: m.cost.input ?? 0,
              output: m.cost.output ?? 0,
              cacheRead: m.cost.cache_read ?? m.cost.input ?? 0,
              cacheWrite: m.cost.cache_write ?? m.cost.input ?? 0,
            },
          }
        : {}),
    };
  }
}
const path = join(import.meta.dir, "../src/providers/registry-snapshot.json");
writeFileSync(
  path,
  `${JSON.stringify({ source: "https://models.dev/api.json", taken: new Date().toISOString().slice(0, 10), models: out }, null, 1)}\n`,
);
console.log(`wrote ${Object.keys(out).length} models to ${path}`);
