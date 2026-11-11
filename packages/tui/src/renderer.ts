// Inline differential renderer (ADR-0005). Finished output is printed once, into the
// terminal's own scrollback, so native scrolling, search and selection keep working. Only a
// small live area at the bottom (streaming text, the prompt, the status line) is redrawn,
// and only the lines that changed, inside a synchronized update so it does not flicker.
import { clip, width } from "./text";

export interface Terminal {
  write(s: string): void;
  columns(): number;
  rows(): number;
}

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const CLEAR_LINE = "\x1b[2K";
const CLEAR_DOWN = "\x1b[J";
const up = (n: number) => (n > 0 ? `\x1b[${n}A` : "");

export class InlineRenderer {
  private shown: string[] = [];
  private live: string[] = [];
  private pending: string[] = [];
  private scheduled = false;

  constructor(
    private readonly term: Terminal,
    private readonly schedule: (fn: () => void) => void = (fn) => queueMicrotask(fn),
  ) {}

  // Lines to print permanently above the live area. They may be longer than the terminal is
  // wide; the terminal wraps them, so copying a long line gives it back whole.
  commit(lines: string[]): void {
    this.pending.push(...lines);
    this.request();
  }

  // The live area's lines. Each must fit the width; longer ones are clipped.
  setLive(lines: string[]): void {
    this.live = lines;
    this.request();
  }

  private request() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  // Draw now. Called by the scheduler, and directly before exit.
  flush(): void {
    const cols = Math.max(10, this.term.columns());
    // Never taller than the screen, or the cursor could not get back to the top.
    const maxRows = Math.max(1, this.term.rows() - 1);
    const next = this.live.slice(-maxRows).map((l) => (width(l) >= cols ? clip(l, cols - 1) : l));
    let out = SYNC_ON + this.toTop();
    if (this.pending.length) {
      out += CLEAR_DOWN + this.pending.map((l) => `${l}\r\n`).join("");
      this.pending = [];
      out += next.map((l) => CLEAR_LINE + l).join("\r\n");
    } else {
      if (sameLines(this.shown, next)) return;
      for (let i = 0; i < next.length; i++) {
        if (i > 0) out += "\r\n";
        // The last line is always rewritten so the cursor ends at its end.
        if (i < this.shown.length && this.shown[i] === next[i] && i !== next.length - 1) continue;
        out += CLEAR_LINE + next[i];
      }
      if (next.length < this.shown.length) out += CLEAR_DOWN;
    }
    this.shown = next;
    this.term.write(out + SYNC_OFF);
  }

  // After a resize the terminal may have reflowed the live area; clear and redraw it whole.
  redraw(): void {
    this.term.write(SYNC_ON + this.toTop() + CLEAR_DOWN + SYNC_OFF);
    this.shown = [];
    this.flush();
  }

  // Remove the live area, leaving the cursor at the start of an empty line.
  clear(): void {
    this.live = [];
    this.term.write(this.toTop() + CLEAR_DOWN);
    this.shown = [];
  }

  private toTop(): string {
    return `\r${up(this.shown.length - 1)}`;
  }
}

function sameLines(a: string[], b: string[]) {
  return a.length === b.length && a.every((l, i) => l === b[i]);
}
