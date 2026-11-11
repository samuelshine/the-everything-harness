// How tool calls and their results are drawn (ADR-0018). They must not read as chat: a
// reply starts with "●", a tool call with "◆ Verb(target)", and its result hangs under "⎿".
// Edits show a diff with line numbers, removed lines on red and added lines on green.
import { parseTodos, type Todo } from "@everything-harness/core";
import type { Style } from "./text";

const MAX_DIFF_LINES = 24;
const MAX_NEW_FILE_LINES = 12;

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

// "Edit src/a.ts" → ◆ Edit(src/a.ts); "Run `npm test`" → ◆ Run(npm test).
export function toolHeader(summary: string, s: Style): string {
  const line = (summary.split("\n")[0] ?? "").trim();
  if (line.startsWith("Update Todos"))
    return `${s.cyan("◆")} ${s.bold("Update Todos")}${s.dim(line.slice("Update Todos".length))}`;
  const space = line.indexOf(" ");
  const verb = space < 0 ? line : line.slice(0, space);
  let rest = space < 0 ? "" : line.slice(space + 1).trim();
  rest = rest.replace(/ \(\d+ lines?\)$/, "");
  if (rest.startsWith("`") && rest.endsWith("`") && rest.length > 1) rest = rest.slice(1, -1);
  if (rest.length > 120) rest = `${rest.slice(0, 119)}…`;
  return `${s.cyan("◆")} ${s.bold(verb)}${rest ? s.dim("(") + rest + s.dim(")") : ""}`;
}

// The header for a call known only by its tool name and arguments (a rebuilt transcript).
export function toolHeaderFromCall(name: string, args: unknown, s: Style): string {
  const a = (typeof args === "object" && args ? args : {}) as Record<string, unknown>;
  const what = [a.file_path, a.notebook_path, a.command, a.pattern, a.path, a.url, a.query].find(
    (v) => typeof v === "string",
  ) as string | undefined;
  if (name === "TodoWrite") return toolHeader("Update Todos", s);
  return toolHeader(`${name}${what ? ` ${what}` : ""}`, s);
}

const result = (text: string, s: Style) => `  ${s.dim("⎿")}  ${text}`;

// One line of diffSnippet's output ("- 12  old text") drawn as "      12 - old text".
function diffLine(l: string, s: Style): string | undefined {
  const m = l.match(/^([ +-]) (\s*\d+) {2}(.*)$/);
  if (!m) return /^ {2}…/.test(l) ? `     ${s.dim(l.trim())}` : undefined;
  const [, sign, num, text] = m as unknown as [string, string, string, string];
  if (sign === "+") return `     ${s.added(`${num} + ${text}`)}`;
  if (sign === "-") return `     ${s.removed(`${num} - ${text}`)}`;
  return `     ${s.dim(`${num}   ${text}`)}`;
}

// The to-do list as a checklist: done items dimmed, the current one in bold.
export function todoLines(todos: Todo[], s: Style): string[] {
  return todos.map((t, i) => {
    const lead = i === 0 ? `  ${s.dim("⎿")}  ` : "     ";
    if (t.status === "completed") return `${lead}${s.dim(`☒ ${t.content}`)}`;
    if (t.status === "in_progress") return `${lead}${s.bold(`◼ ${t.content}`)}`;
    return `${lead}☐ ${t.content}`;
  });
}

export function resultLines(name: string, args: unknown, content: string, isError: boolean, s: Style): string[] {
  if (content.startsWith("Permission denied") || content.startsWith("Blocked by a PreToolUse hook")) return [];
  const lines = content.split("\n");
  const head = (lines.find((l) => l.trim() && l !== "[stderr]") ?? "").slice(0, 160);
  if (isError) return [`  ${s.red(`⎿  ${head}`)}`];

  const edit = head.match(
    /^(edited|overwrote) (.+?)(?: \(\d+ replacements?\))?: (\d+) lines? removed, (\d+) lines? added/,
  );
  if ((name === "Edit" || name === "Write") && edit) {
    const [, , file, removed, added] = edit as unknown as [string, string, string, string, string];
    const diff = lines.slice(1).flatMap((l) => diffLine(l, s) ?? []);
    const more = diff.length > MAX_DIFF_LINES ? [s.dim(`     … ${diff.length - MAX_DIFF_LINES} more lines`)] : [];
    return [
      result(
        `Updated ${s.bold(file)} with ${plural(Number(added), "addition")} and ${plural(Number(removed), "removal")}`,
        s,
      ),
      ...diff.slice(0, MAX_DIFF_LINES),
      ...more,
    ];
  }
  const created = head.match(/^created (.+) \((\d+) lines?\)$/);
  if (name === "Write" && created) {
    const text = (args as { content?: unknown } | undefined)?.content;
    const body = typeof text === "string" ? text.replace(/\n$/, "").split("\n") : [];
    const w = String(Math.min(body.length, MAX_NEW_FILE_LINES)).length;
    const shown = body
      .slice(0, MAX_NEW_FILE_LINES)
      .map((l, i) => `     ${s.added(`${String(i + 1).padStart(w)} + ${l}`)}`);
    const more =
      body.length > MAX_NEW_FILE_LINES ? [s.dim(`     … ${body.length - MAX_NEW_FILE_LINES} more lines`)] : [];
    return [
      result(`Wrote ${plural(body.length || Number(created[2]), "line")} to ${s.bold(created[1] as string)}`, s),
      ...shown,
      ...more,
    ];
  }
  if (name === "Task") {
    const foot = content.match(/\[explore: (.+)\]\s*$/);
    return [result(s.dim(foot ? `Done (${foot[1]})` : "Done"), s)];
  }
  if (name === "Read") return [result(s.dim(`Read ${plural(lines.length, "line")}`), s)];
  if (name === "TodoWrite") {
    try {
      const todos = parseTodos(args);
      return todos.length ? todoLines(todos, s) : [result(s.dim("Cleared the to-do list"), s)];
    } catch {
      return [result(s.dim(head), s)];
    }
  }
  if (name === "WebSearch") {
    const n = lines.filter((l) => /^\d+\. /.test(l)).length;
    return [result(s.dim(n ? `Found ${plural(n, "result")}` : head), s)];
  }
  if (name === "WebFetch") {
    const title = head.includes(" — ") ? head.slice(head.indexOf(" — ") + 3) : head;
    return [result(s.dim(`Fetched ${title}`), s)];
  }
  const n = lines.length;
  return [result(s.dim(`${head}${n > 1 ? ` (+${n - 1} lines)` : ""}`), s)];
}
