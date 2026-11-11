// Context compaction (ADR-0020): when a conversation nears the model's context window, the
// older part is replaced by a summary the model writes, and the recent part is kept word for
// word. The session log keeps everything, so a rewind to a point before the compaction
// brings the full conversation back.
import type { Provider } from "./providers/provider";
import type { SessionLog } from "./session";
import { addUsage, emptyUsage, type Item, type ToolSpec, type Usage } from "./types";

// Compact automatically once a request would fill this much of the window. Ollama refuses a
// request above 90% (see providers/ollama.ts), so this leaves room for one more turn.
export const AUTO_COMPACT_FRACTION = 0.75;
// How much of the window the recent, verbatim part may take after an automatic compaction.
export const KEEP_RECENT_FRACTION = 0.25;
// Starts the summary message, so it is recognisable in later compactions and on resume.
export const COMPACT_MARKER = "[Earlier conversation compacted by teh to save context.]";

const CHARS_PER_TOKEN = 4;
const RESULT_CHARS = 1500; // a tool result's share of the text the summariser reads
const ARGS_CHARS = 400;
const PROMPT_CHARS = 400;
const MAX_PROMPTS = 15;

// Rough token count (~4 characters per token), the same estimate the Ollama adapter uses.
export function estimateTokens(parts: { system?: string; items: Item[]; tools?: ToolSpec[] }): number {
  const chars =
    (parts.system?.length ?? 0) + JSON.stringify(parts.items).length + JSON.stringify(parts.tools ?? []).length;
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const SUMMARY_SYSTEM = `You summarise a coding session between a user and an AI coding agent so the agent can carry on without the full history. Write plain text under these headings, leaving out a heading with nothing under it:

Goal: what the user wants overall, in their terms.
Requests: each thing the user asked for, in order, and whether it is done.
Decisions: choices made and why, including approaches that were tried and dropped.
Files: every file read, created or changed, with what was done to it and its state now. Keep exact paths, function names and identifiers.
Errors: errors met and how they were fixed, or that they are still open.
Current work: what was being done when the summary was made.
Next step: the next action, only if the user asked for it or it follows directly from the current work.

Be specific and complete; do not invent anything. If a summary of an even earlier part is given, fold it in.`;

export type CompactOptions = {
  provider: Provider;
  model: string;
  items: Item[];
  // The model's context window in tokens; sets the chunk size for the summariser.
  contextWindow: number;
  // Tokens of recent conversation to keep verbatim. 0 summarises everything.
  keepTokens: number;
  // Extra direction for the summary, e.g. from "/compact keep the test output".
  instructions?: string;
  signal?: AbortSignal;
};

export type CompactResult = {
  items: Item[];
  summary: string;
  // How many trailing items of the old conversation were kept verbatim.
  keep: number;
  before: number;
  after: number;
  usage: Usage;
};

// A place the conversation can be cut: the kept part may not start with a tool result,
// nor split a tool call from its result.
function canCutAt(items: Item[], i: number): boolean {
  if (i === 0 || i === items.length) return true;
  const here = items[i];
  const prev = items[i - 1];
  if (!here || !prev || here.kind === "tool_result") return false;
  return prev.kind !== "tool_call" && prev.kind !== "reasoning";
}

// The earliest cut that keeps the recent part within `keepTokens`.
export function cutPoint(items: Item[], keepTokens: number): number {
  // Counted as estimateTokens counts the kept part: its JSON, brackets and commas included.
  let chars = 1;
  let best = items.length;
  for (let i = items.length - 1; i >= 0; i--) {
    chars += JSON.stringify(items[i]).length + 1;
    if (Math.ceil(chars / CHARS_PER_TOKEN) > keepTokens) break;
    if (canCutAt(items, i)) best = i;
  }
  return best;
}

const clip = (s: string, n: number) =>
  s.length <= n
    ? s
    : `${s.slice(0, Math.ceil(n * 0.7))}\n… [${s.length - n} characters cut] …\n${s.slice(-Math.floor(n * 0.3))}`;

// The conversation as plain text for the summariser.
export function renderForSummary(items: Item[]): string {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "text") out.push(`[${item.role}]\n${item.text}`);
    else if (item.kind === "tool_call") {
      const args = typeof item.args === "string" ? item.args : JSON.stringify(item.args);
      out.push(`[tool call] ${item.name} ${clip(args, ARGS_CHARS)}`);
    } else if (item.kind === "tool_result")
      out.push(`[tool result: ${item.name}${item.isError ? ", error" : ""}]\n${clip(item.content, RESULT_CHARS)}`);
  }
  return out.join("\n\n");
}

// The user's own prompts: not hook text, skill-router notes or earlier summaries.
function userPrompts(items: Item[]): string[] {
  return items
    .filter((i): i is Extract<Item, { kind: "text" }> => i.kind === "text" && i.role === "user")
    .map((i) => i.text)
    .filter((t) => !t.startsWith(COMPACT_MARKER) && !t.startsWith("(Skill router:") && !/^\w+ hook: /.test(t));
}

function changedFiles(items: Item[]): string[] {
  const files = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool_call" || !["Write", "Edit"].includes(item.name)) continue;
    const args = typeof item.args === "string" ? safeParse(item.args) : item.args;
    const path = (args as { file_path?: unknown } | undefined)?.file_path;
    if (typeof path === "string") files.add(path);
  }
  return [...files];
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

// Summaries from earlier compactions carry their list of requests forward.
function earlierPrompts(items: Item[]): string[] {
  const first = items[0];
  if (first?.kind !== "text" || !first.text.startsWith(COMPACT_MARKER)) return [];
  const m = first.text.match(/\nThe user's requests so far, oldest first:\n([\s\S]*?)(?:\n\n|$)/);
  return m?.[1] ? m[1].split("\n").map((l) => l.replace(/^- /, "")) : [];
}

// The message that stands in for the compacted part. Its deterministic parts (the user's
// requests and the files changed) do not depend on the summary being good.
export function summaryMessage(summary: string, old: Item[], kept: Item[]): string {
  const prompts = [...earlierPrompts(old), ...userPrompts(old).map((p) => clip(p.replace(/\n+/g, " "), PROMPT_CHARS))];
  const recent = prompts.slice(-MAX_PROMPTS);
  const files = changedFiles(old);
  const latestKept = userPrompts(kept).length > 0;
  const latest = userPrompts(old).at(-1);
  return [
    COMPACT_MARKER,
    "",
    summary.trim(),
    ...(recent.length
      ? [
          "",
          "The user's requests so far, oldest first:",
          ...(prompts.length > recent.length ? [`(${prompts.length - recent.length} earlier ones left out)`] : []),
          ...recent.map((p) => `- ${p}`),
        ]
      : []),
    ...(files.length ? ["", `Files changed in the compacted part: ${files.join(", ")}`] : []),
    ...(!latestKept && latest ? ["", `The user's latest request, verbatim:\n${latest}`] : []),
    "",
    "File contents from before this point are no longer in context: read a file again before editing it.",
  ].join("\n");
}

export async function compactConversation(opts: CompactOptions): Promise<CompactResult> {
  const before = estimateTokens({ items: opts.items });
  const cut = cutPoint(opts.items, opts.keepTokens);
  const old = opts.items.slice(0, cut);
  const kept = opts.items.slice(cut);
  if (!old.length) throw new Error("nothing to compact yet");

  // Read in chunks that fit the window with room for the summary so far and the reply.
  const chunkChars = Math.max(4000, Math.floor(opts.contextWindow * 0.5) * CHARS_PER_TOKEN);
  const text = renderForSummary(old);
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkChars) chunks.push(text.slice(i, i + chunkChars));

  let summary = "";
  let usage = emptyUsage();
  for (const [n, chunk] of chunks.entries()) {
    const part = chunks.length > 1 ? ` (part ${n + 1} of ${chunks.length})` : "";
    const prompt = [
      ...(summary ? [`Summary of the session before this part:\n${summary}`, ""] : []),
      `The session${part}:`,
      chunk,
      "",
      `Write the summary${summary ? ", folding in the summary above" : ""}.`,
      ...(opts.instructions ? [`The user asks: ${opts.instructions}`] : []),
    ].join("\n");
    let out = "";
    for await (const ev of opts.provider.stream(
      {
        model: opts.model,
        system: SUMMARY_SYSTEM,
        items: [{ kind: "text", role: "user", text: prompt }],
        tools: [],
        maxOutputTokens: 2048,
        temperature: 0.2,
      },
      opts.signal,
    )) {
      if (ev.type === "text_delta") out += ev.text;
      else if (ev.type === "usage") usage = addUsage(usage, ev.usage);
    }
    if (!out.trim()) throw new Error("the model returned an empty summary");
    summary = out.trim();
  }

  const items: Item[] = [{ kind: "text", role: "user", text: summaryMessage(summary, old, kept) }, ...kept];
  return { items, summary, keep: kept.length, before, after: estimateTokens({ items }), usage };
}

// Record a compaction so a resumed session continues from the compacted conversation.
export function logCompaction(log: SessionLog | undefined, r: CompactResult, trigger: "manual" | "auto"): void {
  const first = r.items[0];
  log?.append("compact", {
    trigger,
    summary: first?.kind === "text" ? first.text : r.summary,
    keep: r.keep,
    before: r.before,
    after: r.after,
  });
}
