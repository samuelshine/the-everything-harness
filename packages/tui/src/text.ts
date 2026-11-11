// Styling, width and wrapping for terminal text. Colour is never the only signal (ADR-0005):
// every coloured mark also has a symbol, and NO_COLOR turns colour off.

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, "");
}

// Wide characters (CJK, most emoji) take two cells. Combining marks take none.
function charWidth(cp: number): number {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0;
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2;
  return 1;
}

export function width(s: string): number {
  let w = 0;
  for (const ch of stripAnsi(s)) w += charWidth(ch.codePointAt(0) ?? 0);
  return w;
}

export type Style = {
  bold: (s: string) => string;
  dim: (s: string) => string;
  italic: (s: string) => string;
  inverse: (s: string) => string;
  red: (s: string) => string;
  green: (s: string) => string;
  yellow: (s: string) => string;
  blue: (s: string) => string;
  magenta: (s: string) => string;
  cyan: (s: string) => string;
  gray: (s: string) => string;
};

const sgr = (on: number, off: number) => (s: string) => `\x1b[${on}m${s}\x1b[${off}m`;

export function makeStyle(color: boolean): Style {
  if (!color) {
    const id = (s: string) => s;
    // Inverse still marks the cursor without colour.
    return {
      bold: id,
      dim: id,
      italic: id,
      inverse: sgr(7, 27),
      red: id,
      green: id,
      yellow: id,
      blue: id,
      magenta: id,
      cyan: id,
      gray: id,
    };
  }
  return {
    bold: sgr(1, 22),
    dim: sgr(2, 22),
    italic: sgr(3, 23),
    inverse: sgr(7, 27),
    red: sgr(31, 39),
    green: sgr(32, 39),
    yellow: sgr(33, 39),
    blue: sgr(34, 39),
    magenta: sgr(35, 39),
    cyan: sgr(36, 39),
    gray: sgr(90, 39),
  };
}

// Split text into tokens: escape sequences (zero width) and single characters.
function tokens(s: string): string[] {
  const out: string[] = [];
  let last = 0;
  for (const m of s.matchAll(ANSI)) {
    out.push(...Array.from(s.slice(last, m.index)));
    out.push(m[0]);
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(...Array.from(s.slice(last)));
  return out;
}

// Hard-wrap one line (no newlines) to `cols` cells, breaking at spaces when it can. Styles
// that span a break are closed and reopened so every physical line stands alone.
export function wrapLine(line: string, cols: number): string[] {
  if (cols < 1) return [line];
  if (width(line) <= cols) return [line];
  const out: string[] = [];
  let cur = "";
  let curW = 0;
  let open = ""; // SGR sequences active since the last reset
  let lastSpace = -1; // index in `cur` after the last space
  let lastSpaceW = 0;
  for (const t of tokens(line)) {
    if (t.startsWith("\x1b")) {
      cur += t;
      if (/^\x1b\[0?m$/.test(t)) open = "";
      else if (t.endsWith("m")) open += t;
      continue;
    }
    const w = charWidth(t.codePointAt(0) ?? 0);
    if (curW + w > cols) {
      if (lastSpace > 0 && t !== " ") {
        const head = cur.slice(0, lastSpace);
        const rest = cur.slice(lastSpace);
        out.push(`${head}${open ? "\x1b[0m" : ""}`);
        cur = open + rest;
        curW -= lastSpaceW;
      } else {
        out.push(`${cur}${open ? "\x1b[0m" : ""}`);
        cur = open;
        curW = 0;
      }
      lastSpace = -1;
      if (t === " " && curW === 0) continue;
    }
    cur += t;
    curW += w;
    if (t === " ") {
      lastSpace = cur.length;
      lastSpaceW = curW;
    }
  }
  out.push(cur);
  return out;
}

export function wrap(text: string, cols: number): string[] {
  return text.split("\n").flatMap((l) => wrapLine(l, cols));
}

// Cut a line to `cols` cells, ending with "…" when it was longer.
export function clip(line: string, cols: number): string {
  if (width(line) <= cols) return line;
  let out = "";
  let w = 0;
  for (const t of tokens(line)) {
    if (t.startsWith("\x1b")) {
      out += t;
      continue;
    }
    const cw = charWidth(t.codePointAt(0) ?? 0);
    if (w + cw > cols - 1) break;
    out += t;
    w += cw;
  }
  return `${out}…\x1b[0m`;
}
