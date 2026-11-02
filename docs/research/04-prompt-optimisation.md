# 04 — Prompt optimisation

## Two different problems
1. **Authoring**: writing good system, tool and agent prompts by hand, following per-model guidance [PRM-09, PRM-10, PRM-11].
2. **Optimising**: automatically improving prompts against a metric using data. This is iterative testing against evaluation metrics, not one-off design [PRM-12].

A harness needs both. It ships well-authored defaults, and it gives users an "optimise this prompt/skill/agent" command once they have evals.

## Hand-authoring: what the vendors say
| Guidance | Claude 4.x [PRM-09] | GPT-5 [PRM-10] |
|----------|---------------------|----------------|
| Explicitness | Be explicit; explain *why* (motivation improves adherence) | Very literal; contradictions badly hurt performance |
| Structure | XML tags for sections and data | Markdown/XML both fine; consistency matters |
| Agentic control | Instruct about parallel tool calls, proactivity vs conservatism, state tracking in files | "Agentic eagerness" prompts plus `reasoning_effort`; tool preambles for progress updates |
| Long tasks | Use git and progress files; context awareness | Persist reasoning via the Responses API |

Implication: **prompts are partly model-specific**. Keep a shared core plus small per-family overlays (Ch. 02).

Tool descriptions are prompts too. Anthropic found that refining tool descriptions and names produced large gains, and recommends using agents to evaluate and rewrite them [MCP-05]. SWE-agent showed interface design itself is a major lever [OTH-08].

## Automatic optimisation: methods
| Method | Mechanism | Evidence | Cost | Sources |
|--------|-----------|----------|------|---------|
| APE | Generate candidate instructions, select by score | Human-level on instruction induction | Low | PRM-06 |
| OPRO | Meta-prompt with (prompt, score) history; LLM proposes better ones | +8% GSM8K, up to +50% BBH vs human prompts | Med | PRM-04 |
| Promptbreeder | Evolves prompts *and* mutation prompts | Beats CoT baselines | High | PRM-07 |
| DSPy (BootstrapFewShot etc.) | Programs with signatures; compile demos and instructions against a metric | Large gains on multi-stage pipelines | Med | PRM-01 |
| MIPRO / MIPROv2 | Bayesian search over instructions and demos per module | Up to +13% over baselines | Med | PRM-02 |
| TextGrad | LLM critiques as "textual gradients" through a graph | GPQA 51→55%, LeetCode-Hard +20% rel. | Med | PRM-05 |
| **GEPA** | Reflects in natural language on *execution traces*; Pareto front of candidates; genetic merge | Beats GRPO (RL) by ~6% avg with up to 35x fewer rollouts; beats MIPROv2 by >10% | Low–Med | PRM-03 |
| ACE | Evolving playbook context, delta updates | +10.6% agents, +8.6% finance; label-free with execution feedback | Low | CTX-13 |

LangChain's head-to-head [PRM-13] adds practical lessons:
- Gains are biggest where the model lacks **domain rules or knowledge** (up to about 200%) and small where the gap is **reasoning**.
- Few-shot works well on simple tasks; meta-prompting with reflection uncovers hidden rules.
- **Overfitting is real.** Always hold out a test split.

## Recommendations for our harness
1. **Prompts as data**: every system prompt, agent prompt, skill body and tool description lives in versioned files with IDs, never inline strings. This is a prerequisite for optimisation, A/B tests and per-model overlays.
2. **Trace capture → dataset**: any session can be marked as an eval example (input, environment snapshot, grader). Ties to Ch. 07 and 09.
3. **`optimise` command** (offline): GEPA-style loop over traces (reflection on failures, candidate prompts, evaluate on train split, keep the Pareto set, report on held-out split). Implement via DSPy/GEPA in a Python sidecar, or natively.
4. **Playbook updates online** (ACE-style): after a session, a reflector proposes itemised additions to project guidance, and the user approves them (diff) before commit. This is safer than silent self-modification.
5. **Tool-description linting**: check length, ambiguity and missing examples; optionally have an agent rewrite tool descriptions and evaluate the result [MCP-05].
6. **Guardrails on optimisation**: never optimise against the test split; cap prompt length growth (brevity bias vs bloat); require human review for prompts that touch safety/permissions.

## Open questions
- What's the metric for a general coding harness? Candidates: task pass rate on an internal suite, Terminal-Bench subset, tokens per success.
- Is per-user optimisation (personal prompts) worth it, or only per-project?

<!-- SOURCES:PRM -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| PRM-01 | [DSPy: Compiling Declarative LM Calls into Self-Improving Pipelines](https://arxiv.org/abs/2310.03714) | Khattab et al. (Stanford) | 2023-10-05 | Must read |
| PRM-02 | [Optimizing Instructions and Demonstrations for Multi-Stage LM Programs (MIPRO)](https://arxiv.org/abs/2406.11695) | Opsahl-Ong et al. (Stanford) | 2024-06-17 | Should read |
| PRM-03 | [GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning](https://arxiv.org/abs/2507.19457) | Agrawal et al. (UC Berkeley, Stanford, Databricks) | 2025-07 | Must read |
| PRM-04 | [Large Language Models as Optimizers (OPRO)](https://arxiv.org/abs/2309.03409) | Yang et al. (Google DeepMind) | 2023-09 | Optional |
| PRM-05 | [TextGrad: Automatic 'Differentiation' via Text](https://arxiv.org/abs/2406.07496) | Yuksekgonul et al. (Stanford) | 2024-06-11 | Optional |
| PRM-06 | [Large Language Models Are Human-Level Prompt Engineers (APE)](https://arxiv.org/abs/2211.01910) | Zhou et al. (U Toronto) | 2022-11-03 | Optional |
| PRM-07 | [Promptbreeder: Self-Referential Self-Improvement via Prompt Evolution](https://arxiv.org/abs/2309.16797) | Fernando et al. (Google DeepMind) | 2023-09-28 | Optional |
| PRM-08 | [The Prompt Report: A Systematic Survey of Prompt Engineering Techniques](https://arxiv.org/abs/2406.06608) | Schulhoff et al. | 2024-06-06 | Optional |
| PRM-09 | [Prompting best practices for Claude 4.x models](https://docs.claude.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices) | Anthropic | current | Must read |
| PRM-10 | [GPT-5 prompting guide](https://cookbook.openai.com/examples/gpt-5/gpt-5_prompting_guide) | OpenAI | 2025-08-07 | Must read |
| PRM-11 | [Prompt design strategies (Gemini)](https://ai.google.dev/gemini-api/docs/prompting-strategies) | Google | current | Optional |
| PRM-12 | [What is Prompt Optimization?](https://www.ibm.com/think/topics/prompt-optimization) | IBM (Vrunda Gadesha) | n.d. | Optional |
| PRM-13 | [Exploring Prompt Optimization](https://www.langchain.com/blog/exploring-prompt-optimization) | LangChain (Maniar, Fu-Hinthorn) | 2025-01-28 | Should read |
<!-- /SOURCES -->
