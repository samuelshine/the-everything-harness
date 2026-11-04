import { describe, expect, test } from "bun:test";
import { commandText, parseShell } from "../src/shell";

const words = (src: string) => {
  const p = parseShell(src);
  if (p.opaque) throw new Error(`opaque: ${p.reason}`);
  return p.commands.map(commandText);
};
const opaque = (src: string) => parseShell(src).opaque;

describe("parseShell", () => {
  test("splits at operators and removes quotes", () => {
    expect(words(`git status && echo "a b" 'c d'; ls|wc -l & pwd`)).toEqual([
      "git status",
      "echo a b c d",
      "ls",
      "wc -l",
      "pwd",
    ]);
    expect(words("a\nb || c")).toEqual(["a", "b", "c"]);
    expect(words("echo a\\ b # comment ; rm -rf /")).toEqual(["echo a b"]);
  });

  test("records redirections with fd prefixes", () => {
    const p = parseShell("cmd 2>&1 >/dev/null <in.txt >>log &>all 3> x");
    if (p.opaque) throw new Error("opaque");
    expect(p.commands[0]?.redirects.map((r) => `${r.op}${r.target.value}`)).toEqual([
      "2>&1",
      ">/dev/null",
      "<in.txt",
      ">>log",
      "&>all",
      "3>x",
    ]);
    expect(p.commands[0]?.words.map((w) => w.value)).toEqual(["cmd"]);
  });

  test("marks expansions, globs and tildes", () => {
    const p = parseShell(`ls $HOME "x$y" '$z' *.ts ~/a {a,b}`);
    if (p.opaque) throw new Error("opaque");
    const w = p.commands[0]?.words ?? [];
    expect(w.map((x) => x.literal)).toEqual([true, false, false, true, true, true, true]);
    expect(w.map((x) => x.glob)).toEqual([false, false, false, false, true, false, true]);
    expect(w[5]?.tilde).toBe(true);
  });

  test("environment assignments are separated from the command", () => {
    const p = parseShell("FOO=1 BAR=2 make");
    if (p.opaque) throw new Error("opaque");
    expect(p.commands[0]?.assigns).toEqual(["FOO=1", "BAR=2"]);
    expect(p.commands[0]?.words.map((x) => x.value)).toEqual(["make"]);
  });

  test("anything it cannot read fully is opaque", () => {
    for (const src of [
      "echo $(rm -rf ~)",
      "echo `id`",
      'echo "$(id)"',
      "(cd /; rm x)",
      "diff <(ls a) <(ls b)",
      "cat <<EOF\nhi\nEOF",
      "if true; then rm x; fi",
      "for f in *; do rm $f; done",
      "f() { rm x; }",
      "$CMD arg",
      "echo $'\\x41'",
      "echo 'unterminated",
      "&& ls",
      "FOO=1",
      "case x in a) ;; esac",
      "{ ls; }",
    ]) {
      expect(opaque(src)).toBe(true);
    }
  });

  test("a trailing ; or & is fine", () => {
    expect(words("ls;")).toEqual(["ls"]);
    expect(words("sleep 1 &")).toEqual(["sleep 1"]);
  });
});
