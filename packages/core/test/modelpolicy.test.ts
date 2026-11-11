import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chooseModel, loadModelScores, type ModelScores, triage } from "../src/modelpolicy";
import { tempDir } from "./helpers";

const GB = 1e9;
const installed = [
  { id: "small", supportsTools: true, sizeBytes: 5 * GB },
  { id: "mid", supportsTools: true, sizeBytes: 9 * GB },
  { id: "big", supportsTools: true, sizeBytes: 20 * GB },
];

describe("model policy", () => {
  test("triage sorts prompts into S, M and L by rules alone", () => {
    expect(triage("what does this do?").tier).toBe("S");
    expect(triage("fix the typo in README").tier).toBe("S");
    expect(triage("add a flag to the export command and print the count").tier).toBe("M");
    expect(triage("refactor the store").tier).toBe("L");
    expect(triage("anything", { planMode: true }).tier).toBe("L");
  });

  test("without scores, size decides; with scores, the fastest model within 2 points of the best wins", () => {
    expect(chooseModel(installed, "S", {})).toEqual({ model: installed[0] as (typeof installed)[0], basis: "size" });
    expect(chooseModel(installed, "L", {})?.model.id).toBe("big");
    const scores: ModelScores = {
      "ollama:small": { S: { pass: 0.2, runs: 9, seconds: 5 }, L: { pass: 0.99, runs: 9, seconds: 30 } },
      "ollama:mid": { S: { pass: 1, runs: 9, seconds: 20 }, L: { pass: 1, runs: 9, seconds: 40 } },
      "ollama:big": { S: { pass: 1, runs: 9, seconds: 12 }, L: { pass: 0.5, runs: 9, seconds: 10 } },
    };
    // S: mid and big both pass everything; big is faster.
    expect(chooseModel(installed, "S", scores)).toEqual({
      model: installed[2] as (typeof installed)[0],
      basis: "measured",
    });
    // L: small is within 2 points of mid and faster; big is fastest but far worse.
    expect(chooseModel(installed, "L", scores)?.model.id).toBe("small");
    // Too few runs do not count; only measured models are considered when any are.
    expect(chooseModel(installed, "M", { "ollama:mid": { M: { pass: 1, runs: 2, seconds: 1 } } })?.basis).toBe("size");
    expect(chooseModel(installed, "M", { "ollama:small": { M: { pass: 0.1, runs: 3, seconds: 1 } } })?.model.id).toBe(
      "small",
    );
    expect(chooseModel([], "S")).toBeUndefined();
  });

  test("your own saved scores replace the built-in ones, tier by tier", () => {
    const home = tempDir();
    expect(loadModelScores(home)).toEqual(loadModelScores(tempDir()));
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, "model-scores.json"),
      JSON.stringify({ models: { "ollama:mine": { S: { pass: 1, runs: 3, seconds: 1 } } } }),
    );
    expect(loadModelScores(home)["ollama:mine"]?.S?.pass).toBe(1);
    writeFileSync(join(home, "model-scores.json"), "not json");
    expect(loadModelScores(home)["ollama:mine"]).toBeUndefined();
  });
});
