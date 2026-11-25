// Cost ledger (ADR-0023; synthesis §3 "cost ledger"): one line per run in ~/.teh/usage.jsonl with the
// model, who paid, tokens and dollars. `teh usage` sums it by day and model. It holds no
// prompts or paths beyond the project folder's name.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type AuthRoute, capabilities, costUsd } from "./providers/registry";
import { addUsage, emptyUsage, type Usage } from "./types";

export type LedgerEntry = {
  at: string; // ISO time the run ended
  session: string;
  project: string; // the folder's name only
  provider: string;
  model: string;
  route: AuthRoute;
  usage: Usage;
  costUsd?: number; // absent when the price is unknown
};

export const ledgerPath = (tehHome: string) => join(tehHome, "usage.jsonl");

export function recordUsage(
  tehHome: string,
  e: { session: string; cwd: string; provider: string; model: string; route: AuthRoute; usage: Usage },
): LedgerEntry | undefined {
  const u = e.usage;
  if (!u.input && !u.output && !u.cachedRead && !u.cacheWrite) return undefined;
  const cost = costUsd(e.route, capabilities(e.provider, e.model), u);
  const entry: LedgerEntry = {
    at: new Date().toISOString(),
    session: e.session,
    project: basename(e.cwd),
    provider: e.provider,
    model: e.model,
    route: e.route,
    usage: u,
    ...(cost !== undefined ? { costUsd: Math.round(cost * 1e6) / 1e6 } : {}),
  };
  try {
    mkdirSync(tehHome, { recursive: true });
    appendFileSync(ledgerPath(tehHome), `${JSON.stringify(entry)}\n`);
  } catch {
    // The ledger is a convenience; a full disk must not fail the run.
  }
  return entry;
}

export function readLedger(tehHome: string): LedgerEntry[] {
  const path = ledgerPath(tehHome);
  if (!existsSync(path)) return [];
  const out: LedgerEntry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as LedgerEntry);
    } catch {}
  }
  return out;
}

export type LedgerRow = { key: string; runs: number; usage: Usage; costUsd?: number; unpriced: number };

// Totals grouped by a key, e.g. the day or "provider:model".
export function summarise(entries: LedgerEntry[], key: (e: LedgerEntry) => string): LedgerRow[] {
  const rows = new Map<string, LedgerRow>();
  for (const e of entries) {
    const k = key(e);
    const row = rows.get(k) ?? { key: k, runs: 0, usage: emptyUsage(), costUsd: 0, unpriced: 0 };
    row.runs++;
    row.usage = addUsage(row.usage, e.usage);
    if (e.costUsd === undefined) row.unpriced++;
    else row.costUsd = (row.costUsd ?? 0) + e.costUsd;
    rows.set(k, row);
  }
  return [...rows.values()];
}
