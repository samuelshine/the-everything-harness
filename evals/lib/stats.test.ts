import { expect, test } from "bun:test";
import { choose, meanOver, passAtK, passHatK, tally } from "./stats";

test("choose", () => {
  expect(choose(5, 2)).toBe(10);
  expect(choose(3, 0)).toBe(1);
  expect(choose(2, 3)).toBe(0);
});

test("pass@k and pass^k bracket the pass rate", () => {
  // 3 of 5 trials pass: pass@1 = pass^1 = 0.6.
  expect(passAtK(5, 3, 1)).toBeCloseTo(0.6);
  expect(passHatK(5, 3, 1)).toBeCloseTo(0.6);
  // pass^2 = C(3,2)/C(5,2) = 0.3; pass@2 = 1 - C(2,2)/C(5,2) = 0.9.
  expect(passHatK(5, 3, 2)).toBeCloseTo(0.3);
  expect(passAtK(5, 3, 2)).toBeCloseTo(0.9);
  expect(passHatK(5, 5, 5)).toBe(1);
  expect(passHatK(5, 4, 5)).toBe(0);
  expect(() => passHatK(2, 1, 3)).toThrow();
});

test("mean over tasks skips tasks with too few trials", () => {
  const t = tally([
    { task: "a", pass: true },
    { task: "a", pass: true },
    { task: "b", pass: true },
    { task: "b", pass: false },
    { task: "c", pass: true },
  ]);
  expect(meanOver(t, 2, passHatK)).toBeCloseTo(0.5);
  expect(meanOver(t, 3, passHatK)).toBeUndefined();
});
