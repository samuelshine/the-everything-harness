// What an edit actually did, shown back to the model (ADR-0002 tool results). Small models
// sometimes replace the wrong text and then report success; seeing the removed and added
// lines lets them notice. One hunk: the span between the unchanged start and end of the file.

const CONTEXT = 2;
const MAX_LINES = 40;

export type DiffSummary = { removed: number; added: number; text: string };

export function diffSnippet(before: string, after: string): DiffSummary {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const removed = a.slice(start, endA);
  const added = b.slice(start, endB);
  const width = String(Math.max(a.length, b.length)).length;
  const num = (n: number) => String(n).padStart(width);
  const lines: string[] = [];
  for (let i = Math.max(0, start - CONTEXT); i < start; i++) lines.push(`  ${num(i + 1)}  ${b[i]}`);
  for (const [i, l] of removed.entries()) lines.push(`- ${num(start + i + 1)}  ${l}`);
  for (const [i, l] of added.entries()) lines.push(`+ ${num(start + i + 1)}  ${l}`);
  for (let i = endB; i < Math.min(b.length, endB + CONTEXT); i++) lines.push(`  ${num(i + 1)}  ${b[i]}`);
  let text = lines.join("\n");
  if (lines.length > MAX_LINES) {
    const head = lines.slice(0, MAX_LINES / 2);
    const tail = lines.slice(-MAX_LINES / 4);
    text = [...head, `  … ${lines.length - head.length - tail.length} more diff lines …`, ...tail].join("\n");
  }
  return { removed: removed.length, added: added.length, text };
}

export function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}
