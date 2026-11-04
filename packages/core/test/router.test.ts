import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FakeProvider, say } from "../src/providers/fake";
import type { Provider } from "../src/providers/provider";
import { cosine, routerHint, SkillRouter } from "../src/router";
import type { Skill } from "../src/skills";
import { tempDir } from "./helpers";

const skill = (name: string, description: string, modelInvocable = true): Skill => ({
  name,
  description,
  kind: "skill",
  source: "user",
  path: `/s/${name}/SKILL.md`,
  dir: `/s/${name}`,
  body: "",
  modelInvocable,
  userInvocable: true,
});

const skills = [
  skill("human", "rewrite prose writing"),
  skill("pdf", "pdf documents forms"),
  skill("deploy", "deploy release", false),
];

// A toy embedder: one dimension per keyword, so similarity is predictable.
const WORDS = ["rewrite", "prose", "writing", "pdf", "documents", "forms", "deploy", "release"];
function embedder() {
  const calls: string[][] = [];
  const p = {
    id: "fake-embed",
    async embed(_model: string, inputs: string[]) {
      calls.push(inputs);
      return inputs.map((text) => WORDS.map((w) => (text.toLowerCase().includes(w) ? 1 : 0)));
    },
  };
  return { provider: p as unknown as Provider, calls };
}

describe("SkillRouter", () => {
  test("embed mode shortlists by similarity, skips skills the model cannot use, and caches", async () => {
    const e = embedder();
    const cacheFile = join(tempDir(), "cache.json");
    const router = new SkillRouter({ mode: "embed", embedder: e.provider, embedModel: "nomic-embed-text", cacheFile });
    const r = await router.route("please rewrite this prose", skills);
    expect(r.chosen).toEqual(["human"]);
    expect(r.candidates[0]).toMatchObject({ name: "human" });
    expect(e.calls[0]).toEqual([
      "search_document: human: rewrite prose writing",
      "search_document: pdf: pdf documents forms",
    ]);
    expect(e.calls[1]).toEqual(["search_query: please rewrite this prose"]);
    expect(existsSync(cacheFile)).toBe(true);

    const again = embedder();
    await new SkillRouter({ mode: "embed", embedder: again.provider, embedModel: "nomic-embed-text", cacheFile }).route(
      "fill the pdf forms",
      skills,
    );
    expect(again.calls).toEqual([["search_query: fill the pdf forms"]]); // descriptions came from the cache
  });

  test("nothing above the threshold means no suggestion", async () => {
    const r = await new SkillRouter({ mode: "embed", embedder: embedder().provider, embedModel: "m" }).route(
      "what time is it",
      skills,
    );
    expect(r.chosen).toEqual([]);
    expect(routerHint(r)).toBeUndefined();
  });

  test("embed+confirm keeps only what the small model confirms, and never a name it invents", async () => {
    const confirm = new FakeProvider([say('{"skills": ["pdf", "made-up"]}')]);
    const r = await new SkillRouter({
      mode: "embed+confirm",
      embedder: embedder().provider,
      embedModel: "m",
      threshold: 0.1,
      confirm: { provider: confirm, model: "tiny" },
    }).route("rewrite the pdf documents", skills);
    expect(r.candidates.map((c) => c.name).sort()).toEqual(["human", "pdf"]);
    expect(r.chosen).toEqual(["pdf"]);
    const req = confirm.requests[0];
    expect(req).toMatchObject({ model: "tiny", json: true, temperature: 0, tools: [] });
    expect(req?.items[0]).toMatchObject({ text: expect.stringContaining("- pdf: pdf documents forms") });
  });

  test("an unusable confirm reply falls back to the shortlist with a note", async () => {
    const r = await new SkillRouter({
      mode: "embed+confirm",
      embedder: embedder().provider,
      embedModel: "m",
      confirm: { provider: new FakeProvider([say("I think human")]), model: "tiny" },
    }).route("rewrite prose", skills);
    expect(r.chosen).toEqual(["human"]);
    expect(r.note).toContain("no usable JSON");
  });

  test("hint wording and cosine", () => {
    expect(routerHint({ mode: "embed", candidates: [], chosen: ["human"], ms: 1 })).toContain("human");
    expect(cosine([1, 0], [1, 0])).toBe(1);
    expect(cosine([1, 0], [0, 1])).toBe(0);
  });
});
