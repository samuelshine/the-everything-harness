// The question asked the first time teh is started in a folder (ADR-0003, ADR-0018):
// does the person trust it? Drawn inline, before the UI takes the screen.
import { KeyParser } from "./keys";
import type { TerminalIo } from "./terminal";
import { makeStyle, wrap } from "./text";

export type TrustAnswer = "trust" | "no" | "quit";

export async function askTrust(
  term: TerminalIo,
  opts: { folder: string; color: boolean; found: string[] },
): Promise<TrustAnswer> {
  const s = makeStyle(opts.color);
  const cols = Math.max(20, term.columns()) - 1;
  const found = opts.found.length
    ? `This folder has ${opts.found.join(", ")}.`
    : "This folder has none of those yet, so this covers any that are added later.";
  const lines = [
    "",
    s.yellow(s.bold("Do you trust the files in this folder?")),
    `  ${s.bold(opts.folder)}`,
    "",
    ...wrap(
      "teh reads, edits and runs files here, and asks before each change either way. Trusting the folder also lets the folder's own configuration apply: its allow rules, hooks, skill grants and MCP servers. Those can run commands without asking, so only trust folders whose contents you know.",
      cols,
    ),
    ...wrap(s.dim(found), cols),
    "",
    `  ${s.bold("y")}  Yes, I trust this folder`,
    `  ${s.bold("n")}  No, open it without the folder's own configuration ${s.dim("(asked again next time)")}`,
    `  ${s.dim("Esc quits")}`,
    "",
  ];
  term.setRawMode(true);
  term.write(`${lines.join("\r\n")}\r\n`);
  const keys = new KeyParser();
  return new Promise<TrustAnswer>((resolve) => {
    const finish = (a: TrustAnswer) => {
      off();
      term.setRawMode(false);
      resolve(a);
    };
    const off = term.onData((data) => {
      // A lone Esc is held back by the parser until the next byte.
      if (data === "\x1b") return finish("quit");
      for (const k of keys.feed(data)) {
        if (k.kind === "char" && /^[yY]$/.test(k.text)) return finish("trust");
        if (k.kind === "char" && /^[nN]$/.test(k.text)) return finish("no");
        if (k.kind === "escape" || k.kind === "ctrlC" || k.kind === "ctrlD") return finish("quit");
      }
    });
  });
}
