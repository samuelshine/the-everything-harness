// The real terminal: process stdin/stdout in raw mode. Tests use a virtual one instead.
import type { Terminal } from "./renderer";

export interface TerminalIo extends Terminal {
  onData(cb: (data: string) => void): () => void;
  onResize(cb: () => void): () => void;
  setRawMode(on: boolean): void;
}

export const BRACKETED_PASTE_ON = "\x1b[?2004h";
export const BRACKETED_PASTE_OFF = "\x1b[?2004l";
export const HIDE_CURSOR = "\x1b[?25l";
export const SHOW_CURSOR = "\x1b[?25h";

export function processTerminal(): TerminalIo {
  const stdin = process.stdin;
  const stdout = process.stdout;
  return {
    write: (s) => {
      stdout.write(s);
    },
    columns: () => stdout.columns || 80,
    rows: () => stdout.rows || 24,
    onData(cb) {
      const handler = (d: Buffer | string) => cb(typeof d === "string" ? d : d.toString("utf8"));
      stdin.on("data", handler);
      stdin.resume();
      return () => {
        stdin.off("data", handler);
        stdin.pause();
      };
    },
    onResize(cb) {
      stdout.on("resize", cb);
      return () => stdout.off("resize", cb);
    },
    setRawMode(on) {
      if (stdin.isTTY) stdin.setRawMode(on);
    },
  };
}
