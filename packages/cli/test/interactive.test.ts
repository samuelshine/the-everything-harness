import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { externalEditor, promptHistory, shellRunner, supportsHyperlinks } from "../src/interactive";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-cli-")));

test("prompt history is kept per project across runs", () => {
  const home = temp();
  const a = promptHistory(home, "/p/a");
  a.add("one");
  a.add("two");
  promptHistory(home, "/p/b").add("other project");
  expect(promptHistory(home, "/p/a").entries).toEqual(["one", "two"]);
  expect(readFileSync(join(home, "history.jsonl"), "utf8").split("\n").filter(Boolean)).toHaveLength(3);
});

test("! commands run in the person's shell and can be stopped", async () => {
  const cwd = temp();
  const run = shellRunner(cwd, { ...process.env, SHELL: "/bin/sh" });
  const r = await run("echo out; echo err >&2; exit 3", new AbortController().signal);
  expect(r.output).toBe("out\nerr\n");
  expect(r.code).toBe(3);
  const abort = new AbortController();
  const slow = run("sleep 5", abort.signal);
  setTimeout(() => abort.abort(), 50);
  expect((await slow).code).toBeNull();
});

test("Ctrl+G runs $EDITOR on a temporary file and returns what was saved", () => {
  const dir = temp();
  const script = join(dir, "ed.sh");
  writeFileSync(script, '#!/bin/sh\nprintf "edited: %s" "$(cat "$1")" > "$1"\n');
  chmodSync(script, 0o755);
  expect(externalEditor({ PATH: process.env.PATH, EDITOR: script })?.("draft")).toBe("edited: draft");
  expect(externalEditor({ PATH: process.env.PATH, EDITOR: "false" })?.("draft")).toBeUndefined();
  expect(externalEditor({})).toBeUndefined();
});

test("hyperlink support by terminal", () => {
  expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app" })).toBe(true);
  expect(supportsHyperlinks({ TERM_PROGRAM: "Apple_Terminal" })).toBe(false);
  expect(supportsHyperlinks({ TERM_PROGRAM: "iTerm.app", TMUX: "1" })).toBe(false);
  expect(supportsHyperlinks({ TEH_HYPERLINKS: "1" })).toBe(true);
  expect(supportsHyperlinks({ KITTY_WINDOW_ID: "1", TEH_HYPERLINKS: "0" })).toBe(false);
});
