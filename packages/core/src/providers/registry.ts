// Capability registry (ADR-0002). What the router, context engine and UI know about a model:
// limits, vision, reasoning and prices. Sources, lowest precedence first: the models.dev
// snapshot bundled at build time, then the user's "modelOverrides" setting.
import type { Usage } from "../types";
import snapshot from "./registry-snapshot.json";

// Prices in US dollars per million tokens.
export type Prices = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type Capabilities = {
  context?: number;
  output?: number;
  vision?: boolean;
  reasoning?: boolean;
  released?: string;
  cost?: Prices;
};

const SNAPSHOT = (snapshot as { models: Record<string, Capabilities> }).models;

// The registry key for a model: "<provider family>:<model id>". Every route to OpenAI's models
// (an API key or a ChatGPT plan) shares OpenAI's entries.
export function registryKey(provider: string, model: string): string {
  return `${provider === "chatgpt" ? "openai" : provider}:${model}`;
}

export function capabilities(
  provider: string,
  model: string,
  overrides: Record<string, Capabilities> = {},
): Capabilities | undefined {
  const key = registryKey(provider, model);
  const base = SNAPSHOT[key];
  const over = overrides[`${provider}:${model}`] ?? overrides[key];
  if (!base && !over) return undefined;
  return { ...base, ...over };
}

// The models the registry knows for a provider family, newest first.
export function knownModels(provider: string): { id: string; caps: Capabilities }[] {
  const prefix = `${registryKey(provider, "")}`;
  return Object.entries(SNAPSHOT)
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, caps]) => ({ id: k.slice(prefix.length), caps }))
    .sort((a, b) => (b.caps.released ?? "").localeCompare(a.caps.released ?? ""));
}

// How a provider is paid for (ADR-0002 "cost per auth route"): an API key pays registry prices;
// a ChatGPT plan and a local model cost nothing per token.
export type AuthRoute = "api-key" | "chatgpt-plan" | "local";

export const ROUTE_LABEL: Record<AuthRoute, string> = {
  "api-key": "API key",
  "chatgpt-plan": "ChatGPT plan",
  local: "local",
};

// The route for a built-in provider id; other OpenAI-compatible servers count as local, since
// their prices are not in the registry.
export function routeOf(providerId: string): AuthRoute {
  if (providerId === "anthropic" || providerId === "openai") return "api-key";
  if (providerId === "chatgpt") return "chatgpt-plan";
  return "local";
}

// Dollars for a usage total, or undefined when the price is unknown.
export function costUsd(route: AuthRoute, caps: Capabilities | undefined, usage: Usage): number | undefined {
  if (route !== "api-key") return 0;
  const p = caps?.cost;
  if (!p) return undefined;
  return (
    (usage.input * p.input +
      usage.cachedRead * p.cacheRead +
      usage.cacheWrite * p.cacheWrite +
      usage.output * p.output) /
    1_000_000
  );
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined) return "unknown";
  if (n === 0) return "$0";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}
