// Reliability statistics for repeated trials.
//
// pass@k: the chance that at least one of k trials passes (Chen et al. 2021, unbiased form).
// pass^k: the chance that all k trials pass (tau-bench, Yao et al. 2024): what a user who runs
// the same task k times experiences. Both are estimated per task from n trials with c passes,
// then averaged over tasks.

// n choose k as a float; exact enough for the small n used here.
export function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i;
  return r;
}

export function passAtK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} exceeds n=${n} trials`);
  return 1 - choose(n - c, k) / choose(n, k);
}

export function passHatK(n: number, c: number, k: number): number {
  if (k > n) throw new Error(`k=${k} exceeds n=${n} trials`);
  return choose(c, k) / choose(n, k);
}

export type TaskTally = { task: string; n: number; c: number };

export function tally(results: { task: string; pass: boolean }[]): TaskTally[] {
  const by = new Map<string, TaskTally>();
  for (const r of results) {
    const t = by.get(r.task) ?? { task: r.task, n: 0, c: 0 };
    t.n++;
    if (r.pass) t.c++;
    by.set(r.task, t);
  }
  return [...by.values()];
}

// Mean over tasks; tasks with fewer than k trials are left out.
export function meanOver(tallies: TaskTally[], k: number, f: (n: number, c: number, k: number) => number) {
  const usable = tallies.filter((t) => t.n >= k);
  if (!usable.length) return undefined;
  return usable.reduce((s, t) => s + f(t.n, t.c, k), 0) / usable.length;
}
