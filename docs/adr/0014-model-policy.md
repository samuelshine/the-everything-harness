# 0014 — Model policy (routing)

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/12-model-routing-and-local-models.md` §1–2, `docs/product.md`; sources [RTE-01]–[RTE-07], [RTE-16], [LLM-08], [LLM-09], [PERF-01]

## Context
The product requires picking a model per task to cut tokens and cost: cheap models for simple work, strong ones for hard work (product brief). The research (doc 12) found three things:
- **Most routers, commercial ones included, fail to reliably beat "always use one mid-tier model"** [RTE-03, RTE-04].
- **The best model still varies per coding task, so there is real money on the table.** Routers improve with task-type outcome data and execution feedback [RTE-02].
- **For an agent, switching model mid-task forfeits the prompt cache and provider reasoning state** [PERF-01].

Two decisions were already taken on 2026-11-03: escalating to a stronger model **asks first**, and a user's pinned model always wins.

## Options considered
1. **No routing:** one model per session, chosen by the user. Simple, but it leaves the requirement unmet.
2. **A per-prompt learned or hosted router** (Not Diamond, OpenRouter Auto and similar) [RTE-07]. The evidence says it often doesn't pay [RTE-04]. It also switches models at the worst moments for caching, and a hosted router sends prompts to a third party.
3. **A layered, local model policy that decides at task boundaries** (chosen).

## Decision
Option 3. The engine has a **model policy** component between the agent loop and the provider layer (ADR-0002).

**Layers:**
1. **Roles** (on by default). Settings map roles to models:

   | Role | Used for | Default model |
   |---|---|---|
   | `main` | The main conversation | The user's chosen model |
   | `plan` | Plan mode | Same as `main` |
   | `fast` | Titles, summaries, commit messages, triage | The cheapest *capable* model on the **same auth route** as `main` |
   | `explore` | Read-only subagents | `fast` |
   | `compact` | Compaction | `main` |
   | `judge` | The evaluator | `main` |

   Background roles are separate requests, so they never break the main conversation's cache. Claude Code's aliases (`opusplan`, `haiku` and so on) map onto these roles (ADR-0010) [RTE-01].
2. **Task triage** (off by default). At the start of a task or subagent, a rule-based classifier assigns tier **S, M or L** and a one-line reason. It uses:
   - prompt length;
   - the files and lines in scope;
   - keywords (for example "refactor", "architecture", "migrate");
   - plan mode;
   - repo size;
   - earlier failures in this session.

   Settings map each tier to a model. A small learned classifier may replace the rules later [RTE-06].
3. **Escalation** (off by default). After a verification failure, the policy proposes the next step at the next task boundary:
   - first, a higher reasoning effort on the same model;
   - then, the next tier.

   Verification failures are failing tests, the evaluator rejecting the work, repeated tool-call errors, or the model giving up. **It asks first:** the prompt shows the current model, the proposed one, the reason and the estimated cost difference. The choices are *yes*, *no*, and *always escalate automatically in this project* (written to project settings). The policy never downgrades mid-task.
4. **Learned policy** (later). Per-task-type success and cost statistics from our evals, and from opt-in usage data, tune the triage rules [RTE-02].

**Rules:**
- **Boundaries only.** Models change at session start, plan→execute, subagent spawn, compaction, background jobs and an approved escalation. They never change within a task's turns.
- **Capability filter first.** A model must support tool calling, the context the task needs (from the registry's *probed* window) and any images or files in the task. Then the cheapest model is chosen by **this user's** cost model (ADR-0002 auth routes).
- **Pins win.** `/model`, `--model` and subagent `model:` fields override everything for their scope.
- **Visible.** The status line shows the model, role or tier, and reason, for example `qwen3-coder · fast · triage: S (2 files, no plan)`. Every change is logged as a `model_change` event (ADR-0004).

**The gate for turning triage and escalation on by default.** On our eval suite (build phase 0), run over whole agent sessions rather than single prompts [RTE-16], a routing preset must beat the best single mid-tier model on **pass rate per dollar**, with no more than a 2-point drop in pass rate across k≥3 runs. Until a preset passes, triage and escalation are opt-in (`"routing": {"enabled": true}`).

**Configuration sketch:**
```json
{
  "model": "sonnet",
  "roles": { "fast": "haiku", "explore": "ollama:qwen3-coder" },
  "routing": {
    "enabled": false,
    "tiers": { "S": "ollama:qwen3-coder", "M": "sonnet", "L": "opus" },
    "escalation": { "ask": true, "maxTier": "L", "sessionBudgetUsd": 5 }
  }
}
```

**Amendment, 2026-11-11: no model pinned.** Starting teh without `--model`, `TEH_MODEL` or a resumed session used to be an error. It now runs triage for that one decision:
- The rules sort the first prompt into S, M or L (length, files named, keywords, plan mode). This makes no model call, so it costs no tokens.
- Among installed models that support tool calling, S takes the smallest, M the middle one and L the largest. Models under about 2 GB are used only when nothing larger is installed.
- The choice is made at session start and holds for the session (boundaries only), so the prompt cache is never thrown away mid-conversation. `/clear` starts a new session and chooses again.
- The chosen model and the reason are shown. A pinned model always wins and skips all of this.

This does not turn triage on for people who pin a model, so the eval gate below still stands for that.

## Consequences
- **Phase 0 (evals) becomes a real dependency** for shipping routing as a default. The policy itself can be built and used opt-in earlier.
- **Telemetry (ADR-0011) gains fields:** role or tier, escalation offered, accepted or declined, auth route, and local or cloud. No prompt-derived features are sent, so triage reasons are reported only as rule ids.
- **Triage rules are code with tests:** fixture prompts map to expected tiers, and changing a rule shows up in review.
- **More approval prompts** under ADR-0008. "Always escalate automatically" is the release valve, and telemetry shows how often people pick it.
- **Revisit** when the learned policy has enough data, or if the eval gate keeps failing. In that case roles alone may be the right long-term answer, which the evidence would support [RTE-03, RTE-04].
