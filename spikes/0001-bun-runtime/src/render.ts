// Minimal inline differential renderer (ADR-0001 spike, check 2).
//
// Model: finished output is written once into the terminal's normal scrollback.
// A small "live region" at the bottom (streaming line, spinner, status) is
// redrawn each frame, but only the lines that changed, inside a DEC 2026
// synchronized-update block so the terminal paints the frame atomically.

const ESC = "\x1b[";
const SYNC_START = "\x1b[?2026h";
const SYNC_END = "\x1b[?2026l";

export class InlineRenderer {
  private prev: string[] = [];
  bytes = 0;
  frames = 0;

  constructor(private out: (s: string) => void) {}

  private write(s: string) {
    this.bytes += Buffer.byteLength(s);
    this.out(s);
  }

  // Move the cursor from the end of the live region to its first line.
  private toTop() {
    return this.prev.length > 1 ? `${ESC}${this.prev.length - 1}A\r` : "\r";
  }

  // Commit lines to scrollback above the live region, then redraw it.
  commit(lines: string[], live: string[]) {
    let s = SYNC_START + this.toTop() + `${ESC}J`; // clear live region only
    for (const l of lines) s += l + "\n";
    s += live.join("\n");
    s += SYNC_END;
    this.write(s);
    this.prev = live.slice();
    this.frames++;
  }

  // Redraw only the live-region lines that changed.
  update(live: string[]) {
    let s = SYNC_START;
    const n = Math.max(live.length, this.prev.length);
    let row = this.prev.length - 1; // cursor sits on the last live line
    for (let i = 0; i < n; i++) {
      const next = live[i] ?? "";
      if (next === this.prev[i]) continue;
      const delta = i - row;
      if (delta < 0) s += `${ESC}${-delta}A`;
      else if (delta > 0) s += i < this.prev.length ? `${ESC}${delta}B` : "\n".repeat(delta);
      s += `\r${next}${ESC}K`;
      row = i;
    }
    const last = live.length - 1;
    if (row < last) s += `${ESC}${last - row}B`;
    else if (row > last && last >= 0) s += `${ESC}${row - last}A`;
    s += SYNC_END;
    if (s.length > SYNC_START.length + SYNC_END.length) this.write(s);
    this.prev = live.slice();
    this.frames++;
  }
}

// Naive renderer for comparison: clears and repaints the whole live region every frame.
export class NaiveRenderer {
  private height = 0;
  bytes = 0;
  frames = 0;
  constructor(private out: (s: string) => void) {}
  private write(s: string) {
    this.bytes += Buffer.byteLength(s);
    this.out(s);
  }
  private clear() {
    return (this.height > 1 ? `${ESC}${this.height - 1}A` : "") + `\r${ESC}J`;
  }
  commit(lines: string[], live: string[]) {
    this.write(this.clear() + lines.map((l) => l + "\n").join("") + live.join("\n"));
    this.height = live.length;
    this.frames++;
  }
  update(live: string[]) {
    this.write(this.clear() + live.join("\n"));
    this.height = live.length;
    this.frames++;
  }
}

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

// A static to-do panel, like the task list a coding agent shows under the stream.
const TODOS = [
  "  ☐ read the failing test",
  "  ☐ locate the parser bug",
  "  ☐ patch tokenizer edge case",
  "  ☐ run the test suite",
  "  ☐ update the changelog",
  "  ☐ summarise the diff",
];

// Streams `total` lines token by token, committing each finished line to scrollback.
export async function runStream(
  r: InlineRenderer | NaiveRenderer,
  total: number,
  opts: { delayMs?: number } = {},
) {
  const words = "the quick brown fox jumps over the lazy dog while the agent streams tokens".split(" ");
  const t0 = performance.now();
  for (let line = 0; line < total; line++) {
    let cur = "";
    for (let w = 0; w < words.length; w += 3) {
      cur += words.slice(w, w + 3).join(" ") + " ";
      r.update([
        `  ${cur}`,
        `${SPIN[(line + w) % SPIN.length]} streaming line ${line + 1}/${total}`,
        ...TODOS,
        `  ctx 12% · $0.004 · model demo`,
      ]);
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
    }
    r.commit([`${String(line + 1).padStart(5)} │ ${cur.trimEnd()}`], [
      "",
      `${SPIN[line % SPIN.length]} streaming line ${line + 1}/${total}`,
      ...TODOS,
      `  ctx 12% · $0.004 · model demo`,
    ]);
  }
  r.update(["", `✓ streamed ${total} lines`, ...TODOS, ""]);
  return performance.now() - t0;
}
