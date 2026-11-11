// Raw terminal input → key events. Handles CSI/SS3 sequences, Alt-prefixed keys, bracketed
// paste, and the xterm/kitty encodings of Shift+Enter that newer terminals send.

export type Key =
  | { kind: "char"; text: string }
  | { kind: "paste"; text: string }
  | {
      kind:
        | "enter"
        | "newline" // Shift+Enter, Alt+Enter, Ctrl+J
        | "backspace"
        | "delete"
        | "left"
        | "right"
        | "up"
        | "down"
        | "home"
        | "end"
        | "wordLeft"
        | "wordRight"
        | "wordBackspace"
        | "tab"
        | "shiftTab"
        | "escape"
        | "ctrlC"
        | "ctrlD"
        | "ctrlA"
        | "ctrlE"
        | "ctrlK"
        | "ctrlU"
        | "ctrlL"
        | "ctrlO";
    };

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const CSI_KEYS: Record<string, Key["kind"]> = {
  A: "up",
  B: "down",
  C: "right",
  D: "left",
  H: "home",
  F: "end",
  Z: "shiftTab",
};

const TILDE_KEYS: Record<string, Key["kind"]> = { "1": "home", "7": "home", "4": "end", "8": "end", "3": "delete" };

// Stateful, because a paste or an escape sequence can arrive split across reads.
export class KeyParser {
  private buf = "";
  private paste: string | undefined;

  // Feed raw input; returns the complete keys. A lone ESC is held until `flushEscape()`,
  // called after a short pause, since it may begin a sequence.
  feed(data: string): Key[] {
    this.buf += data;
    const out: Key[] = [];
    while (this.buf.length) {
      if (this.paste !== undefined) {
        const end = this.buf.indexOf(PASTE_END);
        if (end < 0) {
          this.paste += this.buf;
          this.buf = "";
          break;
        }
        this.paste += this.buf.slice(0, end);
        out.push({ kind: "paste", text: this.paste.replace(/\r\n?/g, "\n") });
        this.paste = undefined;
        this.buf = this.buf.slice(end + PASTE_END.length);
        continue;
      }
      if (this.buf.startsWith(PASTE_START)) {
        this.paste = "";
        this.buf = this.buf.slice(PASTE_START.length);
        continue;
      }
      const consumed = this.one(out);
      if (consumed === 0) break; // incomplete sequence: wait for more input
      this.buf = this.buf.slice(consumed);
    }
    return out;
  }

  // A held ESC with nothing after it is the Escape key.
  flushEscape(): Key[] {
    if (this.buf === "\x1b") {
      this.buf = "";
      return [{ kind: "escape" }];
    }
    return [];
  }

  get pendingEscape(): boolean {
    return this.buf === "\x1b";
  }

  private one(out: Key[]): number {
    const b = this.buf;
    const c = b[0] as string;
    const k = (kind: Key["kind"]) => out.push({ kind } as Key);
    if (c === "\x1b") {
      if (b.length === 1) return 0;
      const n = b[1] as string;
      if (n === "[" || n === "O") {
        // CSI: ESC [ params final; SS3: ESC O final
        const m = b.slice(2).match(/^([0-9;:?]*)([A-Za-z~])/);
        if (!m) return b.length > 16 ? 1 : 0;
        const params = m[1] as string;
        const final = m[2] as string;
        const len = 2 + m[0].length;
        const parts = params.split(";");
        const mod = Number(parts[1] ?? 1) - 1; // 1 shift, 2 alt, 4 ctrl
        if (final === "~") {
          // xterm modifyOtherKeys: ESC [ 27 ; mod ; 13 ~
          if (parts[0] === "27" && parts[2] === "13") k(mod ? "newline" : "enter");
          else if (TILDE_KEYS[parts[0] ?? ""]) k(TILDE_KEYS[parts[0] ?? ""] as Key["kind"]);
          return len;
        }
        if (final === "u") {
          // kitty keyboard protocol: ESC [ code ; mod u
          const code = Number(parts[0]);
          if (code === 13) k(mod ? "newline" : "enter");
          else if (code === 27) k("escape");
          else if (code === 9) k(mod & 1 ? "shiftTab" : "tab");
          else if (code === 127) k("backspace");
          return len;
        }
        const kind = CSI_KEYS[final];
        if (kind) {
          if ((kind === "left" || kind === "right") && mod & 6) k(kind === "left" ? "wordLeft" : "wordRight");
          else k(kind);
        }
        return len;
      }
      // Alt+key
      if (n === "\r" || n === "\n") k("newline");
      else if (n === "\x7f" || n === "\b") k("wordBackspace");
      else if (n === "b") k("wordLeft");
      else if (n === "f") k("wordRight");
      else if (n === "\x1b") {
        k("escape");
        return 1;
      }
      return 2;
    }
    const code = c.charCodeAt(0);
    if (c === "\r") k("enter");
    else if (c === "\n") k("newline");
    else if (c === "\x7f" || c === "\b") k("backspace");
    else if (c === "\t") k("tab");
    else if (code === 3) k("ctrlC");
    else if (code === 4) k("ctrlD");
    else if (code === 1) k("ctrlA");
    else if (code === 5) k("ctrlE");
    else if (code === 11) k("ctrlK");
    else if (code === 21) k("ctrlU");
    else if (code === 23) k("wordBackspace");
    else if (code === 12) k("ctrlL");
    else if (code === 15) k("ctrlO");
    else if (code < 32) {
      // other control keys are ignored
    } else {
      // Printable run up to the next control character, kept together for speed.
      const m = b.match(/^[^\x00-\x1f\x7f\x1b]+/);
      const text = m ? m[0] : c;
      out.push({ kind: "char", text });
      return text.length;
    }
    return 1;
  }
}
