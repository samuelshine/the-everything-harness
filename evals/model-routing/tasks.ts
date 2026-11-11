// Tasks for the model-routing eval: a small JavaScript project and eight jobs of three sizes.
// Each check reads what the run left behind and returns true when the job was done.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE: Record<string, string> = {
  "package.json": '{ "name": "demo", "type": "module" }\n',
  "README.md":
    "# demo\n\nA small library. Call `sum` to add numbers and `slugify` to make URL slugs.\nYou will recieve a number back from every math function.\n",
  "src/math.js": [
    "export const add = (a, b) => a + b;",
    "",
    "export const multiply = (a, b) => a + b;",
    "",
    "export function average(xs) {",
    "  let total = 0;",
    "  for (const x of xs) total += x;",
    "  return total / xs.length;",
    "}",
    "",
  ].join("\n"),
  "src/text.js": [
    "export function slugify(s) {",
    "  return s",
    "    .trim()",
    "    .toLowerCase()",
    '    .replace(/[^a-z0-9]+/g, "-")',
    '    .replace(/^-+|-+$/g, "");',
    "}",
    "",
  ].join("\n"),
  "src/sum.js": [
    "export function sum(xs) {",
    "  let tmp = 0;",
    "  for (const x of xs) {",
    "    tmp = tmp + x;",
    "  }",
    "  return tmp;",
    "}",
    "",
  ].join("\n"),
  "cli.js": [
    'import { sum } from "./src/sum.js";',
    "",
    "const args = process.argv.slice(2);",
    "const numbers = args.map(Number).filter((n) => !Number.isNaN(n));",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the fixture source
    "console.log(`sum: ${sum(numbers)}`);",
    "",
  ].join("\n"),
  "test/math.test.js": [
    'import { expect, test } from "bun:test";',
    'import { add, multiply } from "../src/math.js";',
    "",
    'test("add", () => expect(add(2, 3)).toBe(5));',
    'test("multiply", () => expect(multiply(4, 5)).toBe(20));',
    "",
  ].join("\n"),
};

export type Run = { dir: string; reply: string };
export type Task = { id: string; prompt: string; check: (r: Run) => Promise<boolean> };

const read = (dir: string, f: string) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8") : "");
const bun = (dir: string, args: string[]) =>
  Bun.spawnSync([process.execPath, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });

// Run a snippet of JavaScript against the project and report whether it printed "ok".
function probe(dir: string, code: string): boolean {
  const r = bun(dir, ["-e", code]);
  return r.exitCode === 0 && r.stdout.toString().trim().endsWith("ok");
}
const mod = (dir: string, f: string) => JSON.stringify(join(dir, f));

export const TASKS: Task[] = [
  {
    id: "S1-question",
    prompt: "What does slugify in src/text.js return for 'Hello World'?",
    check: async ({ reply }) => reply.includes("hello-world"),
  },
  {
    id: "S2-typo",
    prompt: "Fix the typo in README.md: recieve should be receive.",
    check: async ({ dir }) => {
      const t = read(dir, "README.md");
      return t.includes("receive a number") && !t.includes("recieve") && t.includes("`slugify`");
    },
  },
  {
    id: "S3-rename",
    prompt: "Rename the variable tmp to total in src/sum.js.",
    check: async ({ dir }) => {
      const t = read(dir, "src/sum.js");
      return (
        !/\btmp\b/.test(t) &&
        /\btotal\b/.test(t) &&
        probe(
          dir,
          `const { sum } = await import(${mod(dir, "src/sum.js")}); console.log(sum([1,2,3]) === 6 ? "ok" : "no")`,
        )
      );
    },
  },
  {
    id: "M1-add-function",
    prompt: "Add an isEven(n) function to src/math.js that returns true for even numbers, and export it.",
    check: async ({ dir }) =>
      probe(
        dir,
        `const m = await import(${mod(dir, "src/math.js")}); console.log(m.isEven(4) === true && m.isEven(7) === false && m.isEven(0) === true && m.add(2, 3) === 5 ? "ok" : "no")`,
      ),
  },
  {
    id: "M2-fix-test",
    prompt: "The tests in test/math.test.js fail. Fix the bug in src/math.js so that bun test passes.",
    check: async ({ dir }) =>
      read(dir, "test/math.test.js") === FIXTURE["test/math.test.js"] && bun(dir, ["test"]).exitCode === 0,
  },
  {
    id: "M3-cli-flag",
    prompt: "Add a --verbose flag to cli.js: when it is passed, print 'verbose on' before anything else.",
    check: async ({ dir }) => {
      const on = bun(dir, ["cli.js", "--verbose", "1", "2"]).stdout.toString().trim().split("\n");
      const off = bun(dir, ["cli.js", "1", "2"]).stdout.toString().trim();
      return on[0] === "verbose on" && on.includes("sum: 3") && off === "sum: 3";
    },
  },
  {
    id: "L1-implement",
    prompt:
      "Implement parseDuration(text) in a new file src/duration.js: it turns strings like '1h30m', '45s' and '2d' into a number of seconds. Export it.",
    check: async ({ dir }) =>
      probe(
        dir,
        `const { parseDuration: p } = await import(${mod(dir, "src/duration.js")}); console.log(p("1h30m") === 5400 && p("45s") === 45 && p("2d") === 172800 && p("1d2h3m4s") === 93784 ? "ok" : "no")`,
      ),
  },
  {
    id: "L2-debug",
    prompt:
      "Debug average in src/math.js: average([]) returns NaN. Make it return 0 for an empty list, and throw a TypeError when the list contains something that is not a number.",
    check: async ({ dir }) =>
      probe(
        dir,
        `const { average } = await import(${mod(dir, "src/math.js")}); let threw = false; try { average([1, "x"]); } catch (e) { threw = e instanceof TypeError; } console.log(average([]) === 0 && average([2, 4]) === 3 && threw ? "ok" : "no")`,
      ),
  },
];
