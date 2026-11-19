// A small Terminal-Bench-style task set: each task is a folder, a request, and a check that
// inspects the folder afterwards (files, program output, git state), never the model's words
// alone. Only node, git and sh are needed, so it runs on any machine teh runs on.
import { type EvalTask, readFile, sh } from "../lib/runner";

const ALLOW = ["Bash(node:*)", "Bash(git:*)", "Bash(sh:*)", "Bash(chmod:*)"];
const node = (dir: string, ...args: string[]) => sh(dir, ["node", ...args]);
const js = (lines: string[]) => `${lines.join("\n")}\n`;

export const TASKS: EvalTask[] = [
  {
    id: "fix-failing-test",
    prompt: "`node test.js` fails. Fix the bug in the library (not the test) and confirm the test passes.",
    files: {
      "package.json": '{ "type": "module" }\n',
      "range.js": js([
        "// Numbers from start up to and including end.",
        "export function range(start, end) {",
        "  const out = [];",
        "  for (let i = start; i < end; i++) out.push(i);",
        "  return out;",
        "}",
      ]),
      "test.js": js([
        'import { range } from "./range.js";',
        "const got = JSON.stringify(range(2, 5));",
        'if (got !== "[2,3,4,5]") { console.error("FAIL", got); process.exit(1); }',
        'console.log("ok");',
      ]),
    },
    allow: ALLOW,
    check: ({ dir }) => node(dir, "test.js").ok && sh(dir, ["git", "diff", "--quiet", "HEAD", "--", "test.js"]).ok,
  },
  {
    id: "csv-summary",
    prompt:
      'sales.csv lists sales by region. Write summary.json: an object mapping each region to its total amount, e.g. {"north": 12.5}.',
    files: {
      "sales.csv": "region,amount\nnorth,10\nsouth,4.5\nnorth,2.5\neast,7\nsouth,0.5\n",
    },
    allow: ALLOW,
    check: ({ dir }) => {
      const got = JSON.parse(readFile(dir, "summary.json") || "{}");
      return got.north === 12.5 && got.south === 5 && got.east === 7 && Object.keys(got).length === 3;
    },
  },
  {
    id: "git-feature-branch",
    prompt:
      'Create a git branch named feature/greet. On it, add greet.js exporting a function greet(name) that returns "Hello, <name>!", and commit it. Leave the working tree clean.',
    files: { "package.json": '{ "type": "module" }\n', "README.md": "# demo\n" },
    allow: ALLOW,
    check: ({ dir }) => {
      if (sh(dir, ["git", "rev-parse", "--abbrev-ref", "HEAD"]).out.trim() !== "feature/greet") return false;
      if (sh(dir, ["git", "status", "--porcelain"]).out.trim()) return false;
      if (!sh(dir, ["git", "cat-file", "-e", "feature/greet:greet.js"]).ok) return false;
      return node(dir, "-e", 'import("./greet.js").then(m => process.exit(m.greet("Ada") === "Hello, Ada!" ? 0 : 1))')
        .ok;
    },
  },
  {
    id: "find-port",
    prompt: "Which TCP port does this server listen on when PORT is not set? Answer with the number.",
    files: {
      "server.js": js([
        'import { createServer } from "node:http";',
        'import { settings } from "./config/index.js";',
        "createServer(() => {}).listen(settings.port);",
      ]),
      "config/index.js": js([
        'import { defaults } from "./defaults.js";',
        "export const settings = { ...defaults, port: Number(process.env.PORT ?? defaults.port) };",
      ]),
      "config/defaults.js": js(['export const defaults = { host: "0.0.0.0", port: 8473 };']),
    },
    check: ({ reply }) => reply.includes("8473"),
  },
  {
    id: "rename-function",
    prompt:
      "Rename the function getUsr to getUser everywhere it is defined or used, then check that `node main.js` still works.",
    files: {
      "package.json": '{ "type": "module" }\n',
      "users.js": js(["export function getUsr(id) {", '  return { id, name: "user" + id };', "}"]),
      "format.js": js([
        'import { getUsr } from "./users.js";',
        "export const label = (id) => getUsr(id).name.toUpperCase();",
      ]),
      "main.js": js([
        'import { getUsr } from "./users.js";',
        'import { label } from "./format.js";',
        "console.log(getUsr(1).name, label(2));",
      ]),
    },
    allow: ALLOW,
    check: ({ dir }) => {
      const all = ["users.js", "format.js", "main.js"].map((f) => readFile(dir, f)).join("\n");
      const r = node(dir, "main.js");
      return !all.includes("getUsr") && all.includes("getUser") && r.ok && r.out.trim() === "user1 USER2";
    },
  },
  {
    id: "log-error-codes",
    prompt:
      "server.log is an application log. Write errors.txt listing each distinct error code (like E1234) that appears on ERROR lines, one per line, sorted, with no duplicates.",
    files: {
      "server.log": [
        "2026-11-01T10:00:00Z INFO started",
        "2026-11-01T10:00:01Z ERROR E2001 database timeout",
        "2026-11-01T10:00:02Z WARN E9999 slow request",
        "2026-11-01T10:00:03Z ERROR E1004 bad input",
        "2026-11-01T10:00:04Z ERROR E2001 database timeout",
        "2026-11-01T10:00:05Z INFO E3000 retry ok",
        "2026-11-01T10:00:06Z ERROR E0420 auth failed",
        "",
      ].join("\n"),
    },
    allow: ALLOW,
    check: ({ dir }) => readFile(dir, "errors.txt").trim().split(/\r?\n/).join(",") === "E0420,E1004,E2001",
  },
  {
    id: "shell-script",
    prompt:
      "Write an executable POSIX sh script count.sh that takes a directory and prints how many files ending in .txt it contains, searching subdirectories too. Print just the number.",
    files: {
      "data/a.txt": "a\n",
      "data/b.md": "b\n",
      "data/nested/c.txt": "c\n",
      "data/nested/deeper/d.txt": "d\n",
      "data/nested/e.txt.bak": "e\n",
    },
    allow: ALLOW,
    check: ({ dir }) => {
      const r = sh(dir, ["./count.sh", "data"]);
      const r2 = sh(dir, ["./count.sh", "data/nested"]);
      return r.ok && r.out.trim() === "3" && r2.out.trim() === "2";
    },
  },
  {
    id: "json-to-csv",
    prompt: "Convert users.json to users.csv with the header id,name,email and one row per user, sorted by id.",
    files: {
      "users.json": `${JSON.stringify(
        [
          { id: 3, name: "Cy", email: "cy@example.com", admin: true },
          { id: 1, name: "Ada", email: "ada@example.com" },
          { id: 2, name: "Bo", email: "bo@example.com" },
        ],
        null,
        2,
      )}\n`,
    },
    allow: ALLOW,
    check: ({ dir }) =>
      readFile(dir, "users.csv").trim().split(/\r?\n/).join("|") ===
      "id,name,email|1,Ada,ada@example.com|2,Bo,bo@example.com|3,Cy,cy@example.com",
  },
  {
    id: "merge-conflict",
    prompt:
      "A git merge of the branch `retries` is in progress and config.js has a conflict. Resolve it so config.js keeps both the timeout from main and the retries setting from the branch, then finish the merge with a commit.",
    files: {
      "package.json": '{ "type": "module" }\n',
      "config.js": js(["export const config = {", "  timeout: 1000,", "};"]),
    },
    setup: [
      ["git", "checkout", "-qb", "retries"],
      ["sh", "-c", "printf 'export const config = {\\n  timeout: 1000,\\n  retries: 3,\\n};\\n' > config.js"],
      ["git", "commit", "-qam", "add retries"],
      ["git", "checkout", "-q", "main"],
      ["sh", "-c", "printf 'export const config = {\\n  timeout: 5000,\\n};\\n' > config.js"],
      ["git", "commit", "-qam", "longer timeout"],
      ["sh", "-c", "git merge -q retries >/dev/null 2>&1; test -f .git/MERGE_HEAD"],
    ],
    allow: ALLOW,
    check: ({ dir }) => {
      if (sh(dir, ["test", "-f", ".git/MERGE_HEAD"]).ok) return false;
      if (/^(<<<<<<<|=======|>>>>>>>)/m.test(readFile(dir, "config.js"))) return false;
      const parents = sh(dir, ["git", "rev-list", "--parents", "-n", "1", "HEAD"]).out.trim().split(" ");
      return (
        parents.length === 3 &&
        node(
          dir,
          "-e",
          'import("./config.js").then(({config:c}) => process.exit(c.timeout === 5000 && c.retries === 3 ? 0 : 1))',
        ).ok
      );
    },
  },
  {
    id: "add-cli-flag",
    prompt:
      "Add an --upper flag to cli.js that prints the greeting in upper case. Without the flag it must behave as before.",
    files: {
      "package.json": '{ "type": "module" }\n',
      "cli.js": js([
        'const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "world";',
        // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the fixture source
        "console.log(`hello, ${name}`);",
      ]),
    },
    allow: ALLOW,
    check: ({ dir }) =>
      node(dir, "cli.js", "ada").out.trim() === "hello, ada" &&
      node(dir, "cli.js", "--upper", "ada").out.trim() === "HELLO, ADA" &&
      node(dir, "cli.js", "ada", "--upper").out.trim() === "HELLO, ADA" &&
      node(dir, "cli.js").out.trim() === "hello, world",
  },
];
