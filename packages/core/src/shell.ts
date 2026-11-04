// A small, conservative shell parser for the permission engine (ADR-0003). It splits a
// command line into simple commands at ; && || | & and newlines, and records each one's
// words and redirections. Anything it does not fully understand, such as $(…), backticks,
// subshells, here-docs, process substitution or control flow, makes the whole line
// "opaque": an opaque command is never auto-allowed and never matched by a prefix rule.

export type Word = {
  // The word after quote removal. Unexpanded parameters keep their `$name` text.
  value: string;
  // No parameter expansion ($x, ${x}) anywhere in it.
  literal: boolean;
  // Unquoted *, ? or [ … ], or brace expansion: it may expand to several paths.
  glob: boolean;
  // Unquoted ~ at the start.
  tilde: boolean;
};

export type Redirect = {
  // The operator with any fd prefix, e.g. ">", "2>", ">>", "&>", "<", "<<<", ">&".
  op: string;
  target: Word;
};

export type SimpleCommand = {
  // NAME=value words before the command name.
  assigns: string[];
  words: Word[];
  redirects: Redirect[];
};

export type ParsedShell = { opaque: false; commands: SimpleCommand[] } | { opaque: true; reason: string };

const RESERVED = new Set([
  "if",
  "then",
  "else",
  "elif",
  "fi",
  "for",
  "while",
  "until",
  "do",
  "done",
  "case",
  "esac",
  "function",
  "select",
  "{",
  "}",
  "[[",
  "]]",
  "!",
  "coproc",
]);
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?\+?=/;
const NAME_CHAR = /[A-Za-z0-9_]/;
const SPECIAL_PARAM = /[@*#?$!0-9-]/;

class Opaque extends Error {}

type Token = { kind: "word"; word: Word } | { kind: "op"; op: string } | { kind: "redir"; op: string };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let cur: Word | undefined;
  const word = () => {
    cur ??= { value: "", literal: true, glob: false, tilde: false };
    return cur;
  };
  const flush = () => {
    if (cur) tokens.push({ kind: "word", word: cur });
    cur = undefined;
  };
  function opaque(why: string): never {
    throw new Opaque(why);
  }

  // $name, ${…}, $(…) etc. Appends to the current word; quoted tells whether inside "…".
  const dollar = () => {
    const next = src[i + 1];
    if (next === "(") opaque("command or arithmetic substitution $(…)");
    if (next === "'" || next === '"') opaque("$'…' or $\"…\" quoting");
    if (next === "{") {
      const end = src.indexOf("}", i + 2);
      if (end < 0) opaque("unterminated parameter expansion");
      const inner = src.slice(i + 2, end);
      if (/[$`(]/.test(inner)) opaque("nested expansion in a parameter expansion");
      word().value += src.slice(i, end + 1);
      word().literal = false;
      i = end + 1;
      return;
    }
    if (next && SPECIAL_PARAM.test(next)) {
      word().value += `$${next}`;
      word().literal = false;
      i += 2;
      return;
    }
    if (next && NAME_CHAR.test(next)) {
      let j = i + 1;
      while (j < src.length && NAME_CHAR.test(src[j] as string)) j++;
      word().value += src.slice(i, j);
      word().literal = false;
      i = j;
      return;
    }
    word().value += "$";
    i++;
  };

  while (i < src.length) {
    const c = src[i] as string;
    const c2 = src.slice(i, i + 2);
    const c3 = src.slice(i, i + 3);

    if (c === " " || c === "\t") {
      flush();
      i++;
      continue;
    }
    if (c === "\n" || c === "\r") {
      flush();
      if (c === "\n") tokens.push({ kind: "op", op: ";" });
      i++;
      continue;
    }
    if (c === "#" && !cur) {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "\\") {
      const n = src[i + 1];
      if (n === undefined) {
        i++;
        continue;
      }
      if (n === "\n") {
        i += 2;
        continue;
      }
      word().value += n;
      i += 2;
      continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      if (end < 0) opaque("unterminated single quote");
      word().value += src.slice(i + 1, end);
      i = end + 1;
      continue;
    }
    if (c === '"') {
      word();
      i++;
      for (;;) {
        if (i >= src.length) opaque("unterminated double quote");
        const d = src[i] as string;
        if (d === '"') {
          i++;
          break;
        }
        if (d === "`") opaque("backtick command substitution");
        if (d === "$") {
          dollar();
          continue;
        }
        if (d === "\\" && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1] as string)) {
          if (src[i + 1] !== "\n") word().value += src[i + 1];
          i += 2;
          continue;
        }
        word().value += d;
        i++;
      }
      continue;
    }
    if (c === "`") opaque("backtick command substitution");
    if (c === "$") {
      dollar();
      continue;
    }
    if (c2 === "<(" || c2 === ">(") opaque("process substitution");
    if (c === "(" || c === ")") opaque("subshell or grouping");

    // Redirections, with an optional fd number written just before them (2>, 1>>).
    if (c === "<" || c === ">" || c2 === "&>") {
      let op: string;
      if (c3 === "<<<") op = "<<<";
      else if (c2 === "<<") opaque("here-document");
      else if (c3 === "&>>") op = "&>>";
      else if (c2 === "&>") op = "&>";
      else if (c2 === ">>" || c2 === ">&" || c2 === "<&" || c2 === ">|" || c2 === "<>") op = c2;
      else op = c;
      if (cur && /^\d+$/.test(cur.value) && cur.literal && !cur.glob) {
        op = cur.value + op;
        cur = undefined;
      } else flush();
      tokens.push({ kind: "redir", op });
      i += op.replace(/^\d+/, "").length;
      continue;
    }
    if (c2 === "&&" || c2 === "||" || c2 === "|&" || c2 === ";;") {
      if (c2 === ";;") opaque("case syntax");
      flush();
      tokens.push({ kind: "op", op: c2 });
      i += 2;
      continue;
    }
    if (c === ";" || c === "|" || c === "&") {
      flush();
      tokens.push({ kind: "op", op: c });
      i++;
      continue;
    }
    if (c === "~" && !cur) {
      word().tilde = true;
      word().value += c;
      i++;
      continue;
    }
    if (c === "*" || c === "?" || c === "[") word().glob = true;
    if (c === "{" && /^\{[^}\s]*(,|\.\.)[^}\s]*\}/.test(src.slice(i))) word().glob = true;
    word().value += c;
    i++;
  }
  flush();
  return tokens;
}

export function parseShell(src: string): ParsedShell {
  let tokens: Token[];
  try {
    tokens = tokenize(src);
  } catch (e) {
    if (e instanceof Opaque) return { opaque: true, reason: e.message };
    throw e;
  }
  const commands: SimpleCommand[] = [];
  let cur: SimpleCommand = { assigns: [], words: [], redirects: [] };
  const end = (op: string): string | undefined => {
    const empty = cur.words.length === 0 && cur.assigns.length === 0 && cur.redirects.length === 0;
    if (empty) {
      // A trailing ; or & is fine; an operator with nothing before it is not.
      if (op === "end" || op === ";") return undefined;
      return `"${op}" with no command before it`;
    }
    if (cur.words.length === 0) return "assignment or redirection without a command";
    commands.push(cur);
    cur = { assigns: [], words: [], redirects: [] };
    return undefined;
  };
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k] as Token;
    if (t.kind === "op") {
      const why = end(t.op);
      if (why) return { opaque: true, reason: why };
      continue;
    }
    if (t.kind === "redir") {
      const next = tokens[k + 1];
      if (next?.kind !== "word") return { opaque: true, reason: `redirection ${t.op} without a target` };
      cur.redirects.push({ op: t.op, target: next.word });
      k++;
      continue;
    }
    const w = t.word;
    if (cur.words.length === 0) {
      if (ASSIGN.test(w.value) && w.literal) {
        cur.assigns.push(w.value);
        continue;
      }
      if (!w.literal) return { opaque: true, reason: "the command name is an expansion" };
      if (RESERVED.has(w.value)) return { opaque: true, reason: `shell keyword "${w.value}"` };
      if (/^\w+=\(/.test(w.value)) return { opaque: true, reason: "array assignment" };
    }
    cur.words.push(w);
  }
  const why = end("end");
  if (why) return { opaque: true, reason: why };
  if (commands.length === 0) return { opaque: true, reason: "empty command" };
  return { opaque: false, commands };
}

// The words of a command as a single line, for matching against rules.
export function commandText(c: SimpleCommand): string {
  return [...c.assigns, ...c.words.map((w) => w.value)].join(" ");
}
