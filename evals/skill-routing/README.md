# Skill-routing eval

Does a small model or an embedding model help a coding agent pick the right skill (ADR-0015)?

## Setup
- **Skills:** 12 fixture skills in [`skills/`](skills/) with realistic descriptions: human, research, commit, pdf, code-review, write-tests, explain-code, sql, docker, translate, changelog, security-review.
- **Cases:** 48 prompts in [`cases.json`](cases.json). For 38 of them one skill is expected (3–4 per skill, varied wording). For 10, none should be (ordinary coding requests).
- **Metrics:**
  - **recall:** prompts needing a skill where the expected one was picked.
  - **exact:** the expected skill and nothing else, or nothing for the 10 no-skill prompts.
  - **false alarms:** no-skill prompts where a skill was picked anyway.
  - **wrong extra:** prompts needing a skill where another skill was picked too.
- **Hardware:** MacBook, 24 GiB RAM, Ollama 0.40.13. Embeddings from `nomic-embed-text`.

```bash
bun evals/skill-routing/run.ts router                                  # embedding threshold sweep
bun evals/skill-routing/run.ts router --confirm ollama:gemma3:1b       # + small confirm model
bun evals/skill-routing/run.ts agent --main ollama:gemma4:e4b --router embed
```
Raw results are in [`results/`](results/).

## Results (2026-11-03, single run each)

**The router alone**, before any main model:

| Router | Recall | Exact | False alarms | Wrong extra | Time per prompt |
|---|---|---|---|---|---|
| embed, threshold 0.6, top 1 | 30/38 | **39/48** | **1/10** | 4/38 | ~15 ms |
| embed, threshold 0.55, top 3 (shortlist) | 34/38 | 7/48 | 7/10 | 33/38 | ~15 ms |
| shortlist + `qwen2.5:0.5b` confirm | 33/38 | 9/48 | 7/10 | 31/38 | ~175 ms |
| shortlist + `gemma3:1b` confirm | 27/38 | 24/48 | 6/10 | 13/38 | ~175 ms |

**End to end:** does the main model (`gemma4:e4b`) call the `Skill` tool with the expected skill on its first turn?

| Router | Recall | Exact | False alarms | Avg time per prompt |
|---|---|---|---|---|
| off (model reads the skill list itself) | 20/38 | 30/48 | 0/10 | 3.1 s |
| **embed** | **32/38** | **42/48** | **0/10** | 3.7 s |
| embed + `gemma3:1b` confirm | 27/38 | 36/48 | 1/10 | 5.5 s |

## Findings
1. **The embedding router helps a small main model a lot.** gemma4:e4b found the right skill for 32 of 38 prompts with it, against 20 without, and still picked no skill when none was needed.
   - Without the router it misses whenever the prompt doesn't echo the skill's wording: "add unit tests", "explain the agent loop", "make the container image smaller", "translate this…".
   - The embedding step costs about 15 ms.
2. **0.5–1B chat models are poor confirmers.**
   - `qwen2.5:0.5b` approved nearly every shortlisted skill.
   - `gemma3:1b` filtered more, but dropped right answers too. It still produced 6 false alarms out of 10, against 1 for embeddings alone.
   - Taking only the top embedding match above 0.6 beat both. End to end, adding the gemma3:1b confirm step lowered gemma4's recall from 32 to 27 of 38, added a false alarm, and slowed each prompt from 3.7 s to 5.5 s, because Ollama swaps the two models in and out of memory on a 24 GiB machine.
3. **The main model keeps false alarms down.** With the router on, gemma4 ignored the hint when it didn't fit: 0 false alarms, against 1 for the router alone.

## Defaults this sets
- `embed` mode: threshold 0.6, top 1.
- `embed+confirm` stays available for experiments, with a shortlist of top 3 above 0.55. These results don't support recommending it.
- The router stays **off by default** until it is tested with strong cloud models, which may not need it (ADR-0014).

## Limits
- One run per setting. 48 cases written by the same person who wrote the skills.
- One main model and one embedding model.
- No cloud models yet, because the API keys are deferred.
