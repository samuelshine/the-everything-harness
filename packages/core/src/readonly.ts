// Which parsed shell commands are read-only (ADR-0003), so they can run without asking.
// Deliberately conservative: a command is read-only only if it is on the list below, uses
// none of the flags that make it write or execute, sets no environment variables, writes
// no files through redirection, and every path-like argument stays inside the workspace.
import { isAbsolute, resolve } from "node:path";
import type { Redirect, SimpleCommand, Word } from "./shell";

export type PathCheck = {
  // Directory relative paths start from.
  cwd: string;
  home: string;
  // True when a read of this absolute path needs no approval.
  readable: (abs: string) => boolean;
};

export type ReadOnlyVerdict = { ok: true } | { ok: false; why: string };

type Spec = {
  // Words, or word prefixes ending in "=", that make the command unsafe.
  denyWords?: string[];
  // Single-letter flags that make it unsafe, also inside clusters like -ro.
  denyShort?: string;
  // Most positional arguments allowed (e.g. uniq IN OUT writes OUT).
  maxPositionals?: number;
  // How many leading positionals are patterns or text rather than paths.
  nonPathPositionals?: number;
  // All positionals are text (echo, printf).
  textOnly?: boolean;
  // Extra check over the arguments.
  check?: (args: Word[]) => string | undefined;
};

const PLAIN: Spec = {};
const SPECS: Record<string, Spec> = {
  ls: PLAIN,
  pwd: PLAIN,
  cat: PLAIN,
  head: PLAIN,
  tail: PLAIN,
  wc: PLAIN,
  stat: PLAIN,
  du: PLAIN,
  df: PLAIN,
  diff: PLAIN,
  cmp: PLAIN,
  comm: PLAIN,
  cut: PLAIN,
  paste: PLAIN,
  nl: PLAIN,
  tac: PLAIN,
  rev: PLAIN,
  fold: PLAIN,
  expand: PLAIN,
  unexpand: PLAIN,
  strings: PLAIN,
  od: PLAIN,
  hexdump: PLAIN,
  basename: { textOnly: true },
  dirname: { textOnly: true },
  realpath: PLAIN,
  readlink: PLAIN,
  which: { textOnly: true },
  type: { textOnly: true },
  whoami: PLAIN,
  id: PLAIN,
  uname: PLAIN,
  true: PLAIN,
  false: PLAIN,
  ps: PLAIN,
  seq: { textOnly: true },
  column: PLAIN,
  tr: { textOnly: true },
  test: { textOnly: true },
  "[": { textOnly: true },
  echo: { textOnly: true },
  printf: { textOnly: true },
  md5sum: PLAIN,
  md5: PLAIN,
  shasum: PLAIN,
  sha1sum: PLAIN,
  sha256sum: PLAIN,
  sha512sum: PLAIN,
  cksum: PLAIN,
  grep: { nonPathPositionals: 1 },
  egrep: { nonPathPositionals: 1 },
  fgrep: { nonPathPositionals: 1 },
  rg: { nonPathPositionals: 1, denyWords: ["--pre="] },
  jq: { nonPathPositionals: 1 },
  file: { denyShort: "C", denyWords: ["--compile"] },
  sort: { denyShort: "o", denyWords: ["--output=", "--compress-program="] },
  uniq: { maxPositionals: 1 },
  xxd: { maxPositionals: 1 },
  tree: { denyShort: "o", denyWords: ["--output="] },
  hostname: { maxPositionals: 0, denyShort: "F", denyWords: ["--file="] },
  date: {
    denyShort: "s",
    denyWords: ["--set="],
    textOnly: true,
    check: (args) =>
      args.some((a) => !a.value.startsWith("-") && !a.value.startsWith("+"))
        ? "date with a value sets the clock"
        : undefined,
  },
  find: {
    denyWords: ["-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint", "-fprint0", "-fprintf", "-fls"],
  },
};

// Flags that take a separate value, per command, so the value isn't mistaken for a positional.
const VALUE_FLAGS: Record<string, string[]> = {
  grep: ["-e", "-f", "-m", "-A", "-B", "-C", "--include", "--exclude", "--exclude-dir", "-d", "-D"],
  rg: [
    "-e",
    "-f",
    "-g",
    "-t",
    "-T",
    "-m",
    "-A",
    "-B",
    "-C",
    "--glob",
    "--type",
    "--type-not",
    "--max-count",
    "-M",
    "-j",
  ],
  head: ["-n", "-c"],
  tail: ["-n", "-c"],
  cut: ["-d", "-f", "-c", "-b"],
  sort: ["-t", "-k", "-S", "-T"],
  du: ["-d", "--max-depth"],
  tree: ["-L", "-I", "-P"],
  jq: ["--arg", "--argjson", "--slurpfile", "--rawfile", "--indent"],
};

// git: global options and read-only subcommands.
const GIT_DENY_COMMON = ["--output=", "--output", "--ext-diff", "--open-files-in-pager"];
const GIT_READ = new Set([
  "status",
  "log",
  "diff",
  "show",
  "blame",
  "annotate",
  "ls-files",
  "ls-tree",
  "cat-file",
  "rev-parse",
  "rev-list",
  "describe",
  "shortlog",
  "grep",
  "whatchanged",
  "merge-base",
  "show-ref",
  "show-branch",
  "name-rev",
  "count-objects",
  "version",
  "check-ignore",
  "check-attr",
]);

function shortFlags(w: string): string | undefined {
  return /^-[A-Za-z0-9]+$/.test(w) ? w.slice(1) : undefined;
}

function flagDenied(w: string, spec: Spec): boolean {
  for (const d of spec.denyWords ?? []) {
    if (d.endsWith("=") ? w === d.slice(0, -1) || w.startsWith(d) : w === d) return true;
  }
  const short = shortFlags(w);
  return short !== undefined && [...(spec.denyShort ?? "")].some((l) => short.includes(l));
}

// Split arguments into flags and positionals, skipping the values of known value flags.
function positionals(cmd: string, args: Word[]): { flags: Word[]; pos: Word[]; values: Word[] } {
  const takesValue = new Set(VALUE_FLAGS[cmd] ?? []);
  const flags: Word[] = [];
  const pos: Word[] = [];
  const values: Word[] = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as Word;
    if (!endOfFlags && a.value === "--") {
      endOfFlags = true;
      continue;
    }
    if (!endOfFlags && a.value.startsWith("-") && a.value !== "-") {
      flags.push(a);
      if (takesValue.has(a.value) && args[i + 1]) {
        values.push(args[i + 1] as Word);
        i++;
      }
      continue;
    }
    pos.push(a);
  }
  return { flags, pos, values };
}

// A path-like word must resolve to somewhere readable. Words that cannot name a file
// outside the workspace by their text (no leading / or ~, no ..) are assumed relative.
export function pathProblem(w: Word, p: PathCheck): string | undefined {
  if (!w.literal) return `${w.value} is not a literal value`;
  let v = w.value;
  const eq = v.startsWith("-") ? v.indexOf("=") : -1;
  if (eq >= 0) v = v.slice(eq + 1);
  else if (v.startsWith("-")) return undefined;
  if (!v || v === "-") return undefined;
  if (w.tilde) v = v === "~" ? p.home : v.startsWith("~/") ? `${p.home}${v.slice(1)}` : "/";
  // Every path is resolved (symlinks too, by readable) and checked against Read deny rules.
  // For globs, judge the fixed part before the first wildcard.
  const fixed = w.glob ? v.slice(0, v.search(/[*?[{]/)) || "." : v;
  const abs = resolve(p.cwd, fixed);
  return p.readable(abs) ? undefined : `${w.value} is outside the workspace or blocked by a Read rule`;
}

function redirectProblem(r: Redirect, p: PathCheck): string | undefined {
  const t = r.target.value;
  const op = r.op.replace(/^\d+/, "");
  if ((op === ">&" || op === "<&") && /^(\d+|-)$/.test(t)) return undefined;
  if (op === "<<<") return r.target.literal ? undefined : "here-string with an expansion";
  if (op === "<") return pathProblem(r.target, p);
  if (t === "/dev/null" && r.target.literal) return undefined;
  return `writes to ${t}`;
}

function checkGit(args: Word[], p: PathCheck): string | undefined {
  let i = 0;
  // Global options before the subcommand.
  while (i < args.length && (args[i] as Word).value.startsWith("-")) {
    const g = (args[i] as Word).value;
    if (g === "--no-pager" || g === "--no-optional-locks" || g === "-P") {
      i++;
      continue;
    }
    if (g === "-C") {
      const dir = args[i + 1];
      if (!dir) return "git -C without a directory";
      const bad = pathProblem(dir, p);
      if (bad) return bad;
      i += 2;
      continue;
    }
    return `git option ${g} is not known to be read-only`;
  }
  const sub = args[i]?.value;
  if (!sub) return undefined;
  const rest = args.slice(i + 1);
  for (const a of rest) {
    if (!a.literal) return `${a.value} is not a literal value`;
    if (GIT_DENY_COMMON.some((d) => (d.endsWith("=") ? a.value.startsWith(d) : a.value === d)))
      return `git ${sub} ${a.value} can write or run commands`;
    const bad = pathProblem(a, p);
    if (bad) return bad;
  }
  const flags = rest.filter((a) => a.value.startsWith("-")).map((a) => a.value);
  const pos = rest.filter((a) => !a.value.startsWith("-")).map((a) => a.value);
  const listOnly = (allowed: string[], listFlags: string[]) => {
    const okFlag = (f: string) => allowed.some((x) => (x.endsWith("=") ? f.startsWith(x) : f === x));
    const bad = flags.find((f) => !okFlag(f));
    if (bad) return `git ${sub} ${bad} may change something`;
    if (pos.length && !flags.some((f) => listFlags.some((x) => (x.endsWith("=") ? f.startsWith(x) : f === x))))
      return `git ${sub} with a name changes something`;
    return undefined;
  };

  if (GIT_READ.has(sub)) {
    if (sub === "grep" && flags.some((f) => /^-[A-Za-z]*O/.test(f))) return "git grep -O opens a pager command";
    return undefined;
  }
  switch (sub) {
    case "branch":
      return listOnly(
        [
          "-a",
          "-r",
          "-v",
          "-vv",
          "-l",
          "--list",
          "--all",
          "--remotes",
          "--verbose",
          "--show-current",
          "--no-color",
          "--color",
          "--color=",
          "--sort=",
          "--format=",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--points-at",
          "--column",
          "--no-column",
        ],
        ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
      );
    case "tag":
      return listOnly(
        [
          "-l",
          "--list",
          "-n",
          "--sort=",
          "--format=",
          "--contains",
          "--no-contains",
          "--merged",
          "--no-merged",
          "--points-at",
          "--column",
        ],
        ["-l", "--list", "--contains", "--no-contains", "--merged", "--no-merged", "--points-at"],
      );
    case "remote":
      if (pos.length === 0)
        return flags.every((f) => f === "-v" || f === "--verbose") ? undefined : "git remote option";
      return pos[0] === "get-url" ? undefined : `git remote ${pos[0]} may change something`;
    case "stash":
      return pos[0] === "list" || pos[0] === "show" ? undefined : "git stash changes the working tree";
    case "reflog":
      return pos.length === 0 || pos[0] === "show" ? undefined : `git reflog ${pos[0]} changes the reflog`;
    case "worktree":
      return pos[0] === "list" ? undefined : `git worktree ${pos[0] ?? ""} may change something`;
    case "config": {
      const reads = ["--get", "--get-all", "--get-regexp", "--list", "-l", "--show-origin", "--show-scope"];
      const scopes = ["--global", "--local", "--system", "--worktree", "--null", "-z", "--name-only", "--includes"];
      if (pos[0] === "get" || pos[0] === "list") {
        return flags.every((f) => reads.includes(f) || scopes.includes(f)) ? undefined : "git config option";
      }
      if (!flags.some((f) => ["--get", "--get-all", "--get-regexp", "--list", "-l"].includes(f)))
        return "git config without --get or --list may set a value";
      return flags.every((f) => reads.includes(f) || scopes.includes(f)) ? undefined : "git config option";
    }
    default:
      return `git ${sub} is not known to be read-only`;
  }
}

// sed is read-only only when its script just prints lines: "20,40p", "$p", "/start/,/end/p".
const SED_ADDR = String.raw`(?:\d+|\$|/(?:[^/\\]|\\.)*/)`;
const SED_PRINT = new RegExp(String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*${SED_ADDR})?\s*p\s*(?:;\s*|$))+$`);

function checkSed(args: Word[], p: PathCheck): string | undefined {
  const scripts: Word[] = [];
  const files: Word[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as Word;
    if (a.value === "-e" || a.value === "--expression") {
      const s = args[i + 1];
      if (!s) return "sed -e without a script";
      scripts.push(s);
      i++;
    } else if (["-n", "--quiet", "--silent", "-E", "-r", "--regexp-extended"].includes(a.value)) continue;
    else if (a.value.startsWith("-")) return `sed ${a.value} is not known to be read-only`;
    else if (scripts.length === 0 && !args.slice(0, i).some((x) => x.value === "-e")) scripts.push(a);
    else files.push(a);
  }
  if (scripts.length === 0) return "sed without a script";
  for (const s of scripts) {
    if (!s.literal || !SED_PRINT.test(s.value)) return "sed script does more than print lines";
  }
  for (const f of files) {
    const bad = pathProblem(f, p);
    if (bad) return bad;
  }
  return undefined;
}

// Strip harmless wrappers: timeout, nice, time. Returns the inner command's words.
export function unwrap(words: Word[]): Word[] {
  let w = words;
  for (;;) {
    const head = w[0]?.value;
    if (head === "time") {
      w = w.slice(w[1]?.value === "-p" ? 2 : 1);
    } else if (head === "nice") {
      let k = 1;
      if (w[k]?.value === "-n") k += 2;
      else if (/^-n?\d+$/.test(w[k]?.value ?? "")) k++;
      w = w.slice(k);
    } else if (head === "timeout") {
      let k = 1;
      while (w[k]?.value.startsWith("-")) {
        const f = w[k]?.value ?? "";
        k += f === "-s" || f === "-k" || f === "--signal" || f === "--kill-after" ? 2 : 1;
      }
      w = w.slice(k + 1); // the duration
    } else return w;
  }
}

export function isReadOnly(cmd: SimpleCommand, p: PathCheck): ReadOnlyVerdict {
  if (cmd.assigns.length) return { ok: false, why: "sets environment variables" };
  for (const r of cmd.redirects) {
    const bad = redirectProblem(r, p);
    if (bad) return { ok: false, why: bad };
  }
  const words = unwrap(cmd.words);
  const name = words[0]?.value;
  if (!name || !words[0]?.literal) return { ok: false, why: "no command" };
  const args = words.slice(1);
  if (name === "git") {
    const bad = checkGit(args, p);
    return bad ? { ok: false, why: bad } : { ok: true };
  }
  if (name === "sed") {
    const bad = checkSed(args, p);
    return bad ? { ok: false, why: bad } : { ok: true };
  }
  if (name === "cd") {
    const target = args[0];
    if (args.length > 1 || !target || target.value === "-") return { ok: false, why: "cd outside the workspace" };
    const bad = pathProblem(target, p);
    return bad ? { ok: false, why: bad } : { ok: true };
  }
  const spec = SPECS[name];
  if (!spec) return { ok: false, why: `${name} is not on the read-only list` };
  for (const a of args) {
    if (flagDenied(a.value, spec)) return { ok: false, why: `${name} ${a.value} can write or run commands` };
  }
  if (spec.check) {
    const bad = spec.check(args);
    if (bad) return { ok: false, why: bad };
  }
  if (spec.textOnly) {
    return args.every((a) => a.literal) ? { ok: true } : { ok: false, why: "an argument is an expansion" };
  }
  const { flags, pos, values } = positionals(name, args);
  if (spec.maxPositionals !== undefined && pos.length > spec.maxPositionals)
    return { ok: false, why: `${name} with ${pos.length} arguments may write a file` };
  // With -e or -f the pattern is a flag value, so every positional is a path.
  const patternInFlag = flags.some((f) => /^-(e|f)$|^--(regexp|file)=?/.test(f.value));
  const skip = patternInFlag ? 0 : (spec.nonPathPositionals ?? 0);
  const pathWords = name === "find" ? findStarts(args) : [...flags, ...values, ...pos.slice(skip)];
  for (const w of pathWords) {
    const bad = pathProblem(w, p);
    if (bad) return { ok: false, why: bad };
  }
  // A pattern may hold anything, but must not be an expansion.
  for (const w of pos.slice(0, skip)) if (!w.literal) return { ok: false, why: `${w.value} is not a literal value` };
  return { ok: true };
}

// find's starting points come before the first expression word.
function findStarts(args: Word[]): Word[] {
  const out: Word[] = [];
  for (const a of args) {
    if (a.value.startsWith("-") || a.value === "(" || a.value === "!") break;
    out.push(a);
  }
  // Expression values must still be literal (-newer FILE etc. are judged as paths too).
  return [...out, ...args.slice(out.length).filter((a) => !a.literal || isAbsolute(a.value) || a.value.includes(".."))];
}
