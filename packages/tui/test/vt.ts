// A minimal virtual terminal for tests: interprets the escape sequences the renderer emits
// and keeps every line (scrollback included) as plain text, so tests can assert on what a
// person would see.
import type { TerminalIo } from "../src/terminal";

export class VirtualTerminal implements TerminalIo {
  // The normal buffer (with scrollback) and, while a full-screen app runs, the alternate screen.
  main: string[] = [""];
  alt: string[] | undefined;
  private saved = { row: 0, col: 0 };
  row = 0;
  col = 0;
  raw = false;
  written = "";
  private dataCb: ((d: string) => void) | undefined;
  private resizeCb: (() => void) | undefined;

  constructor(
    public cols = 80,
    public height = 24,
  ) {}

  columns() {
    return this.cols;
  }
  rows() {
    return this.height;
  }
  setRawMode(on: boolean) {
    this.raw = on;
  }
  onData(cb: (d: string) => void) {
    this.dataCb = cb;
    return () => {
      this.dataCb = undefined;
    };
  }
  onResize(cb: () => void) {
    this.resizeCb = cb;
    return () => {
      this.resizeCb = undefined;
    };
  }

  // What the person types.
  type(data: string) {
    this.dataCb?.(data);
  }

  resize(cols: number) {
    this.cols = cols;
    this.resizeCb?.();
  }

  get lines(): string[] {
    return this.alt ?? this.main;
  }

  get screenTop() {
    return this.alt ? 0 : Math.max(0, this.lines.length - this.height);
  }

  // What is on the active buffer, as text: the whole scrollback, or the alternate screen.
  text(): string {
    return this.lines.map((l) => l.trimEnd()).join("\n");
  }

  write(s: string) {
    this.written += s;
    let i = 0;
    while (i < s.length) {
      const c = s[i] as string;
      if (c === "\x1b") {
        const m = s.slice(i).match(/^\x1b\[([0-9;?]*)([A-Za-z~])/);
        if (!m) {
          i++;
          continue;
        }
        this.csi(m[1] as string, m[2] as string);
        i += m[0].length;
        continue;
      }
      if (c === "\r") this.col = 0;
      else if (c === "\n") {
        this.row++;
        if (this.alt) this.row = Math.min(this.row, this.alt.length - 1);
        else if (this.row >= this.lines.length) this.lines.push("");
      } else if (c === "\x07") {
        // bell
      } else {
        const ch = String.fromCodePoint(s.codePointAt(i) ?? 32);
        const line = (this.lines[this.row] ?? "").padEnd(this.col, " ");
        this.lines[this.row] = line.slice(0, this.col) + ch + line.slice(this.col + 1);
        this.col++;
        i += ch.length;
        continue;
      }
      i++;
    }
  }

  private csi(params: string, final: string) {
    if (params === "?1049" && final === "h") {
      this.saved = { row: this.row, col: this.col };
      this.alt = Array.from({ length: this.height }, () => "");
      this.row = 0;
      this.col = 0;
      return;
    }
    if (params === "?1049" && final === "l") {
      this.alt = undefined;
      ({ row: this.row, col: this.col } = this.saved);
      return;
    }
    if (params.startsWith("?") || final === "m") return;
    if (final === "H") {
      const [r, c] = params.split(";").map((x) => Number(x || 1));
      this.row = this.screenTop + (r ?? 1) - 1;
      this.col = (c ?? 1) - 1;
      while (this.lines.length <= this.row) this.lines.push("");
      return;
    }
    if (final === "J" && params === "2") {
      for (let i = this.screenTop; i < this.lines.length; i++) this.lines[i] = "";
      return;
    }
    const n = Number(params || 1);
    if (final === "A") this.row = Math.max(this.screenTop, this.row - n);
    else if (final === "K") this.lines[this.row] = "";
    else if (final === "J") {
      this.lines[this.row] = (this.lines[this.row] ?? "").slice(0, this.col);
      if (this.alt) for (let i = this.row + 1; i < this.alt.length; i++) this.alt[i] = "";
      else this.main.length = this.row + 1;
    }
  }
}
