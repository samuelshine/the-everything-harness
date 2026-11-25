// Each task's check must reject the untouched fixture and accept a known-good solution, so a
// pass in the eval means the job was done, not that the check is loose.
import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, sh } from "../lib/runner";
import { TASKS } from "./tasks";

const SOLUTIONS: Record<string, { reply?: string; apply?: (dir: string) => void }> = {
  "fix-failing-test": {
    apply: (d) =>
      writeFileSync(
        join(d, "range.js"),
        "export const range = (s, e) => Array.from({ length: e - s + 1 }, (_, i) => s + i);\n",
      ),
  },
  "csv-summary": { apply: (d) => writeFileSync(join(d, "summary.json"), '{"north":12.5,"south":5,"east":7}\n') },
  "git-feature-branch": {
    apply: (d) => {
      sh(d, ["git", "checkout", "-qb", "feature/greet"]);
      writeFileSync(join(d, "greet.js"), 'export const greet = (n) => "Hello, " + n + "!";\n');
      sh(d, ["git", "add", "greet.js"]);
      sh(d, ["git", "commit", "-qm", "greet"]);
    },
  },
  "find-port": { reply: "It listens on port 8473." },
  "rename-function": {
    apply: (d) => {
      for (const f of ["users.js", "format.js", "main.js"]) {
        const p = join(d, f);
        writeFileSync(p, readFileSync(p, "utf8").replaceAll("getUsr", "getUser"));
      }
    },
  },
  "log-error-codes": { apply: (d) => writeFileSync(join(d, "errors.txt"), "E0420\nE1004\nE2001\n") },
  "shell-script": {
    apply: (d) => {
      writeFileSync(join(d, "count.sh"), '#!/bin/sh\nfind "$1" -type f -name "*.txt" | wc -l | tr -d " "\n');
      sh(d, ["chmod", "+x", "count.sh"]);
    },
  },
  "json-to-csv": {
    apply: (d) =>
      writeFileSync(
        join(d, "users.csv"),
        "id,name,email\n1,Ada,ada@example.com\n2,Bo,bo@example.com\n3,Cy,cy@example.com\n",
      ),
  },
  "merge-conflict": {
    apply: (d) => {
      writeFileSync(join(d, "config.js"), "export const config = {\n  timeout: 5000,\n  retries: 3,\n};\n");
      sh(d, ["git", "add", "config.js"]);
      sh(d, ["git", "commit", "-qm", "merge retries"]);
    },
  },
  "add-cli-flag": {
    apply: (d) =>
      writeFileSync(
        join(d, "cli.js"),
        'const a = process.argv.slice(2);\nconst name = a.find((x) => !x.startsWith("--")) ?? "world";\nconst s = "hello, " + name;\nconsole.log(a.includes("--upper") ? s.toUpperCase() : s);\n',
      ),
  },
};

for (const task of TASKS) {
  test(`${task.id}: check rejects the fixture and accepts a solution`, async () => {
    const solution = SOLUTIONS[task.id];
    expect(solution).toBeDefined();
    const before = prepare(task);
    expect(await task.check({ dir: before, reply: "", stdout: "" })).toBe(false);
    rmSync(before, { recursive: true, force: true });

    const dir = prepare(task);
    solution?.apply?.(dir);
    expect(await task.check({ dir, reply: solution?.reply ?? "", stdout: "" })).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
}
