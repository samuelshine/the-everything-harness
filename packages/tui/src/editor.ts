// The prompt editor: multi-line text with a cursor, history, and the usual readline keys.
// The cursor is drawn as an inverse cell, so the terminal's own cursor can stay hidden.
import type { Key } from "./keys";
import { type Style, wrapLine } from "./text";

export type EditorResult = { submit?: string } | undefined;

const prevIndex = (s: string, i: number) =>
  i >= 2 && /[\uDC00-\uDFFF]/.test(s[i - 1] ?? "") ? i - 2 : Math.max(0, i - 1);
const nextIndex = (s: string, i: number) =>
  i < s.length && /[\uD800-\uDBFF]/.test(s[i] ?? "") ? Math.min(s.length, i + 2) : Math.min(s.length, i + 1);

export class Editor {
  text = "";
  cursor = 0;
  private history: string[] = [];
  private historyAt = -1; // -1 = editing a new entry
  private draft = "";

  constructor(history: string[] = []) {
    this.history = [...history];
  }

  get historyEntries(): readonly string[] {
    return this.history;
  }

  set(text: string) {
    this.text = text;
    this.cursor = text.length;
  }

  insert(s: string) {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
    this.historyAt = -1;
  }

  // Returns { submit } on Enter. Other keys edit in place.
  handle(key: Key): EditorResult {
    const t = this.text;
    const c = this.cursor;
    const lineStart = t.lastIndexOf("\n", c - 1) + 1;
    const lineEndAt = t.indexOf("\n", c);
    const lineEnd = lineEndAt < 0 ? t.length : lineEndAt;
    switch (key.kind) {
      case "char":
      case "paste":
        this.insert(key.text);
        return;
      case "newline":
        this.insert("\n");
        return;
      case "enter":
        // A trailing backslash continues the prompt on a new line, as in Claude Code.
        if (c > 0 && t[c - 1] === "\\" && c === t.length) {
          this.text = `${t.slice(0, c - 1)}\n`;
          this.cursor = this.text.length;
          return;
        }
        return this.submit();
      case "backspace":
        if (c > 0) {
          const p = prevIndex(t, c);
          this.text = t.slice(0, p) + t.slice(c);
          this.cursor = p;
        }
        return;
      case "delete":
        if (c < t.length) this.text = t.slice(0, c) + t.slice(nextIndex(t, c));
        return;
      case "left":
        this.cursor = prevIndex(t, c);
        return;
      case "right":
        this.cursor = nextIndex(t, c);
        return;
      case "home":
      case "ctrlA":
        this.cursor = lineStart;
        return;
      case "end":
      case "ctrlE":
        this.cursor = lineEnd;
        return;
      case "wordLeft":
        this.cursor = wordStart(t, c);
        return;
      case "wordRight":
        this.cursor = wordEnd(t, c);
        return;
      case "wordBackspace": {
        const p = wordStart(t, c);
        this.text = t.slice(0, p) + t.slice(c);
        this.cursor = p;
        return;
      }
      case "ctrlU":
        this.text = t.slice(0, lineStart) + t.slice(c);
        this.cursor = lineStart;
        return;
      case "ctrlK":
        this.text = t.slice(0, c) + t.slice(lineEnd === c && c < t.length ? c + 1 : lineEnd);
        return;
      case "up":
        if (lineStart > 0) {
          const col = c - lineStart;
          const prevStart = t.lastIndexOf("\n", lineStart - 2) + 1;
          this.cursor = Math.min(prevStart + col, lineStart - 1);
        } else this.recall(1);
        return;
      case "down":
        if (lineEnd < t.length) {
          const col = c - lineStart;
          const nextEndAt = t.indexOf("\n", lineEnd + 1);
          const nextEnd = nextEndAt < 0 ? t.length : nextEndAt;
          this.cursor = Math.min(lineEnd + 1 + col, nextEnd);
        } else this.recall(-1);
        return;
      default:
        return;
    }
  }

  private submit(): EditorResult {
    const text = this.text;
    if (text.trim() && this.history.at(-1) !== text) this.history.push(text);
    this.text = "";
    this.cursor = 0;
    this.historyAt = -1;
    return { submit: text };
  }

  // Step through history: 1 = older, -1 = newer.
  private recall(dir: 1 | -1) {
    if (!this.history.length) return;
    if (this.historyAt === -1) {
      if (dir === -1) return;
      this.draft = this.text;
      this.historyAt = this.history.length - 1;
    } else {
      const next = this.historyAt - dir;
      if (next >= this.history.length) {
        this.historyAt = -1;
        this.set(this.draft);
        return;
      }
      this.historyAt = Math.max(0, next);
    }
    this.set(this.history[this.historyAt] ?? "");
  }

  // Lines to show, wrapped to `cols`, with the cursor drawn in.
  render(style: Style, cols: number, placeholder = ""): string[] {
    const prefixFirst = `${style.cyan("›")} `;
    const prefixMore = "  ";
    const inner = Math.max(4, cols - 2);
    if (!this.text) {
      // The cursor sits on the placeholder's first letter.
      if (!placeholder) return [`${prefixFirst}${style.inverse(" ")}`];
      return [`${prefixFirst}${style.inverse(placeholder.slice(0, 1))}${style.dim(placeholder.slice(1))}`];
    }
    const out: string[] = [];
    let offset = 0;
    for (const [i, line] of this.text.split("\n").entries()) {
      const start = offset;
      offset += line.length + 1;
      let shown = line;
      if (this.cursor >= start && this.cursor <= start + line.length) {
        const at = this.cursor - start;
        const ch = line.slice(at, nextIndex(line, at)) || " ";
        shown =
          line.slice(0, at) + style.inverse(ch) + line.slice(at + (ch === " " && at >= line.length ? 0 : ch.length));
      }
      for (const [j, part] of wrapLine(shown, inner).entries())
        out.push(`${i === 0 && j === 0 ? prefixFirst : prefixMore}${part}`);
    }
    return out;
  }
}

function wordStart(t: string, c: number) {
  let i = c;
  while (i > 0 && /\s/.test(t[i - 1] ?? "")) i--;
  while (i > 0 && !/\s/.test(t[i - 1] ?? "")) i--;
  return i;
}

function wordEnd(t: string, c: number) {
  let i = c;
  while (i < t.length && /\s/.test(t[i] ?? "")) i++;
  while (i < t.length && !/\s/.test(t[i] ?? "")) i++;
  return i;
}
