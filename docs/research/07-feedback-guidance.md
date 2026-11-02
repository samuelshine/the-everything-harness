# 07 — Feedback & guidance

## Framing: guides and sensors [FBK-14]
Böckeler (on martinfowler.com) splits harness controls along two axes:

|  | **Computational** (deterministic, fast) | **Inferential** (LLM-based, richer, slower) |
|--|------------------------------------------|---------------------------------------------|
| **Guides** (feedforward: before acting) | Templates, scaffolds, type definitions, hook-injected context, allowlists | System prompt, AGENTS.md, skills, plans, examples |
| **Sensors** (feedback: after acting) | Tests, linters, type checkers, build, structural/architecture tests, hooks that block | LLM-as-judge, reviewer/evaluator agents, critique |

Her advice: use both, prefer computational where possible, run cheap checks early ("keep quality left"), and put human review where judgment matters. Behaviour verification remains the least solved area.

## What the research says about self-correction
- **Intrinsic self-correction is unreliable.** Without external feedback, LLMs often fail to fix reasoning errors and sometimes make them worse [FBK-03].
- **External signals make it work.**
  - CRITIC: tool-based verification (search, code execution) [FBK-04].
  - Reflexion: written reflections on test/environment failures, kept in episodic memory, reached 91% HumanEval pass@1 [FBK-01].
- **Process feedback beats outcome-only feedback** for multi-step reasoning [FBK-07]. Check plans and diffs, not only final answers.
- **Self-Refine** helps on style and format tasks where the model can judge quality [FBK-02].

## Separate evaluators beat self-critique
Anthropic's 2026 long-running harness found it's **easier to make a standalone evaluator skeptical than to make a generator critical of its own work** [FBK-08]. Their setup:
- a planner expands the spec;
- a generator builds in sprints;
- an evaluator exercises the *running app* (Playwright) and grades it against explicit criteria (design quality, originality, craft, functionality) before the next sprint.

This is the evaluator-optimizer pattern from [AGT-01], made concrete.

## LLM-as-judge: use it carefully [FBK-06]
Strong judges agree with humans about 80% of the time, but they have biases:
- **position** (prefer the first answer),
- **verbosity** (prefer longer),
- **self-enhancement** (prefer their own family's outputs).

Mitigations:
- swap order and average;
- use explicit rubrics and reference answers;
- use a different model family as judge;
- calibrate against human labels.

## Deterministic guidance in production harnesses
- **Hooks** [FBK-10]: shell commands fired on lifecycle events. They can **block** an action, **modify** inputs, or **inject context**. Events: `PreToolUse`, `PostToolUse`, `UserPromptSubmit`, `Stop`/`SubagentStop`, `SessionStart`, `PreCompact`, `Notification`. Hooks turn "please always run the formatter" from a hope into a guarantee.
- **Agent-readable linters and tests** [FBK-09]: OpenAI's Codex team enforced architecture with custom lints and structural tests whose **error messages contain the fix instructions**. Every failure is a targeted guide. They also treat AGENTS.md as a short map pointing into a structured `docs/` tree rather than an encyclopedic manual.
- **Guardrails with tripwires** [FBK-12]: cheap validators run in parallel with the agent on inputs and outputs and halt it on violation.
- **Think tool** [FBK-11]: a no-op "think" tool gives space for policy checks mid-trajectory. It helped policy-heavy τ-bench tasks, mainly for models without interleaved thinking.
- **Constitutions/rubrics** [FBK-05]: written principles used for critique and revision. Useful as the rubric for reviewer agents.

## Human feedback channels
- **Approvals**: permission prompts at boundary crossings only (Ch. 09).
- **Interrupt and steer**: the user can inject a message mid-turn. The harness queues it and delivers it at the next safe point.
- **Plan review**: a plan mode where the agent proposes and the human approves before writes [BAS-01].
- **Learn from corrections**: when a user corrects the agent, propose an AGENTS.md or memory delta (ACE-style) for approval [CTX-13].

## Evals as the outer feedback loop [FBK-13]
- **Grade outcomes, not transcripts.** Check the environment state, because agents claim success they didn't achieve.
- Use code-based, model-based and human graders; separate **capability** evals (hill-climb) from **regression** evals (must not drop).
- Measure reliability with **pass^k** (all k trials succeed), not just pass@k [OTH-10].

## Recommendations for our harness
1. **Hook system** compatible with Claude Code's event names and JSON I/O (block, modify, add context) [FBK-10].
2. **Verify step in the core loop**: after edits, run project-configured checks (format → lint → typecheck → targeted tests) automatically. Feed failures back as structured, actionable messages.
3. **Retry with reflection**: on failed verification, the agent writes a short "what went wrong / next approach" note that persists for that task [FBK-01].
4. **Built-in evaluator role** (isolated context, skeptical prompt, real tools such as a browser or test runner, rubric) that can gate "done" [FBK-08, CTX-19].
5. **Judge utilities** with bias mitigations baked in (order swap, rubric, cross-family) [FBK-06].
6. **Guardrail API** for parallel tripwire validators [FBK-12].
7. **Correction capture → guidance deltas** with user approval.
8. A **guide/sensor inventory** command that lists all active guides and sensors for a project, so users can see what's enforced.

## Open questions
- When should the evaluator run: every turn, every N edits, or only at "done"? This trades cost against catching drift.
- How do we stop the agent from gaming tests (editing tests to pass)? Options: protected paths via hooks, feature-list status-only edits [CTX-03].

<!-- SOURCES:FBK -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| FBK-01 | [Reflexion: Language Agents with Verbal Reinforcement Learning](https://arxiv.org/abs/2303.11366) | Shinn et al. | 2023-03 | Must read |
| FBK-02 | [Self-Refine: Iterative Refinement with Self-Feedback](https://arxiv.org/abs/2303.17651) | Madaan et al. | 2023-03-30 | Optional |
| FBK-03 | [Large Language Models Cannot Self-Correct Reasoning Yet](https://arxiv.org/abs/2310.01798) | Huang et al. (Google DeepMind) | 2023-10 | Must read |
| FBK-04 | [CRITIC: LLMs Can Self-Correct with Tool-Interactive Critiquing](https://arxiv.org/abs/2305.11738) | Gou et al. | 2023-05-19 | Should read |
| FBK-05 | [Constitutional AI: Harmlessness from AI Feedback](https://arxiv.org/abs/2212.08073) | Bai et al. (Anthropic) | 2022-12-15 | Optional |
| FBK-06 | [Judging LLM-as-a-Judge with MT-Bench and Chatbot Arena](https://arxiv.org/abs/2306.05685) | Zheng et al. (LMSYS) | 2023-06-09 | Must read |
| FBK-07 | [Let's Verify Step by Step](https://arxiv.org/abs/2305.20050) | Lightman et al. (OpenAI) | 2023-05-31 | Optional |
| FBK-08 | [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) | Anthropic (Prithvi Rajasekaran) | 2026-03 | Must read |
| FBK-09 | [Harness engineering: leveraging Codex in an agent-first world](https://openai.com/index/harness-engineering/) | OpenAI | 2026-02 | Must read |
| FBK-10 | [Hooks reference (Claude Code)](https://docs.claude.com/en/docs/claude-code/hooks) | Anthropic | current | Must read |
| FBK-11 | [The 'think' tool: enabling Claude to stop and think](https://www.anthropic.com/engineering/claude-think-tool) | Anthropic | 2025-03 | Optional |
| FBK-12 | [Guardrails (OpenAI Agents SDK)](https://openai.github.io/openai-agents-python/guardrails/) | OpenAI | current | Should read |
| FBK-13 | [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents) | Anthropic | 2026-01-09 | Must read |
| FBK-14 | [Harness Engineering for Coding Agent Users](https://martinfowler.com/articles/harness-engineering.html) | Martin Fowler site (Birgitta Böckeler, Thoughtworks) | 2026-04-02 | Must read |
<!-- /SOURCES -->
