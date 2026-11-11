// Full-screen renderer (ADR-0018): the UI owns the whole terminal on the alternate screen.
// A header line at the top, the conversation in a scrollable viewport, and the live area
// (streaming line, approval, prompt box, status) pinned to the bottom. Every frame is
// diffed by row against the last one and only changed rows are rewritten.
import type { Screen, Terminal } from "./renderer";
import { clip, width, wrapLine } from "./text";

const SYNC_ON = "\x1b[?2026h";
const SYNC_OFF = "\x1b[?2026l";
const ALT_ON = "\x1b[?1049h";
const ALT_OFF = "\x1b[?1049l";
// Wheel events (SGR encoding). Plain drag-select then needs Shift (or Option on macOS).
const MOUSE_ON = "\x1b[?1000h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1000l\x1b[?1006l";
const at = (row: number) => `\x1b[${row};1H\x1b[2K`;

export type FullscreenOptions = {
  // The top line, e.g. "teh · model · cwd". Called on every frame.
  header?: (cols: number) => string;
  // Styles the "more below" marker.
  dim?: (s: string) => string;
  mouse?: boolean;
  schedule?: (fn: () => void) => void;
};

export class FullscreenRenderer implements Screen {
  private transcript: string[] = [];
  private wrapped: string[] = [];
  private wrappedCols = 0;
  private live: string[] = [];
  private offset = 0; // rows scrolled up from the bottom; 0 follows new output
  private shown: string[] = [];
  private scheduled = false;
  private active = false;
  private readonly schedule: (fn: () => void) => void;

  constructor(
    private readonly term: Terminal,
    private readonly opts: FullscreenOptions = {},
  ) {
    this.schedule = opts.schedule ?? ((fn) => queueMicrotask(fn));
  }

  enter(): void {
    this.active = true;
    this.term.write(`${ALT_ON}\x1b[H\x1b[2J${this.opts.mouse === false ? "" : MOUSE_ON}`);
    this.shown = [];
    this.flush();
  }

  leave(): void {
    if (!this.active) return;
    this.active = false;
    this.term.write(`${this.opts.mouse === false ? "" : MOUSE_OFF}${ALT_OFF}`);
  }

  commit(lines: string[]): void {
    this.transcript.push(...lines);
    if (this.wrappedCols) {
      const added = lines.flatMap((l) => wrapLine(l, this.wrappedCols - 1));
      this.wrapped.push(...added);
      // Someone reading earlier output keeps their place.
      if (this.offset > 0) this.offset += added.length;
    }
    this.request();
  }

  setLive(lines: string[]): void {
    this.live = lines;
    this.request();
  }

  // Empty the transcript, for /clear.
  reset(): void {
    this.transcript = [];
    this.wrapped = [];
    this.offset = 0;
    this.request();
  }

  scroll(by: "line" | "page" | "end", direction: 1 | -1): void {
    if (by === "end") this.offset = direction > 0 ? Number.MAX_SAFE_INTEGER : 0;
    else {
      const step = by === "line" ? 3 : Math.max(1, this.viewportRows() - 2);
      this.offset = Math.max(0, this.offset + direction * step);
    }
    this.request();
  }

  get scrolledUp(): boolean {
    return this.offset > 0;
  }

  private request() {
    if (this.scheduled) return;
    this.scheduled = true;
    this.schedule(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  private liveRows(): string[] {
    const rows = this.term.rows();
    return this.live.slice(-Math.max(1, rows - 2));
  }

  private viewportRows(): number {
    return Math.max(1, this.term.rows() - 1 - this.liveRows().length);
  }

  flush(): void {
    if (!this.active) return;
    const cols = Math.max(10, this.term.columns());
    const rows = Math.max(3, this.term.rows());
    if (this.wrappedCols !== cols) {
      this.wrappedCols = cols;
      this.wrapped = this.transcript.flatMap((l) => wrapLine(l, cols - 1));
    }
    const fit = (l: string) => (width(l) >= cols ? clip(l, cols - 1) : l);
    const live = this.liveRows().map(fit);
    const v = Math.max(1, rows - 1 - live.length);
    const total = this.wrapped.length;
    this.offset = Math.min(this.offset, Math.max(0, total - v));
    const end = total - this.offset;
    const view = this.wrapped.slice(Math.max(0, end - v), end).map(fit);
    while (view.length < v) view.push("");
    if (this.offset > 0) {
      const dim = this.opts.dim ?? ((s: string) => s);
      view[v - 1] = fit(
        dim(`  ↓ ${this.offset} more line${this.offset === 1 ? "" : "s"} below · PgDn or End to follow`),
      );
    }
    const frame = [fit(this.opts.header?.(cols) ?? ""), ...view, ...live];
    let out = "";
    for (let i = 0; i < frame.length; i++) if (this.shown[i] !== frame[i]) out += at(i + 1) + frame[i];
    for (let i = frame.length; i < this.shown.length; i++) out += at(i + 1);
    this.shown = frame;
    if (out) this.term.write(SYNC_ON + out + SYNC_OFF);
  }

  redraw(): void {
    this.shown = [];
    this.wrappedCols = 0;
    if (this.active) this.term.write("\x1b[H\x1b[2J");
    this.flush();
  }

  clear(): void {
    this.live = [];
  }
}
