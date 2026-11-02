# 05 — Skill connector (model-agnostic)

## What a "skill" is now
Anthropic introduced **Agent Skills** in Oct 2025 [SKL-01] and published the format as an **open standard** in Dec 2025 [SKL-02]. OpenAI Codex and many other coding agents have since adopted it [SKL-03, SKL-04]. A skill is a **folder**:

```
my-skill/
├── SKILL.md          # YAML frontmatter (name, description, …) + instructions
├── reference.md      # optional extra docs, loaded only if SKILL.md points to them
├── scripts/          # optional executables the agent can run
└── assets/           # templates, schemas, data
```

**Progressive disclosure** is the core mechanism [SKL-01]:
1. At start, only each skill's `name` and `description` go into context (a few dozen tokens each).
2. When a task matches, the agent reads the full `SKILL.md`.
3. The skill body can point at further files and scripts, loaded or executed only if needed.

So you can install hundreds of skills at near-zero context cost. Scripts let deterministic work (parsing a PDF, filling a form) be **executed** rather than generated.

## Why it's model-agnostic
Skills are plain files plus instructions. Any model with file-read and shell tools can use them. The harness only needs to:
- discover skills,
- put their metadata into context,
- offer a way to "activate" them (a tool, or simply reading the file),
- optionally enforce `allowed-tools` restrictions.

This is the same reason AGENTS.md works across 60k+ repos and most coding agents [SKL-07, MCP-07].

## Related "guidance as files" formats
| Format | Scope | Loaded when | Sources |
|--------|-------|-------------|---------|
| AGENTS.md / CLAUDE.md | Project/dir instructions | Always (session start / directory entry) | SKL-07, CTX-18 |
| SKILL.md | Task capability | On demand (progressive) | SKL-01, SKL-02 |
| Subagent .md | Specialist persona + tool allowlist + model | When delegated | AGT-08 |
| Slash command .md | User-invoked prompt template | User invokes | MCP-11 |
| Plugin | Bundle of all of the above + hooks + MCP | Installed | MCP-11 |

## Skill libraries that grow themselves
Voyager stored verified code skills in a retrievable library and composed them for new tasks. That produced 3.3x more unique items and up to 15.3x faster milestones in Minecraft [SKL-08]. ACE's playbooks [CTX-13] and Anthropic's skill-creator skill [SKL-05] point the same way. The agent can **draft new skills from successful trajectories**. In a harness, those drafts should be human-reviewed before activation, because a skill is executable guidance and therefore a supply-chain risk [OTH-05].

## Recommendations for our harness
1. **Spec-compliant skill loader** [SKL-02]:
   - discovery paths in precedence order: built-in, user `~/.<harness>/skills`, project `.agents/skills` and `.claude/skills` (for compatibility), plugin-provided;
   - validate frontmatter and surface errors.
2. **Metadata budget**: cap the total skill-description tokens. If there are too many skills, switch to a `skill_search` tool, the same pattern as tool search [MCP-04].
3. **Activation**: a `Skill` tool that returns `SKILL.md`, plus normal file reads for referenced files. Log activations for evals ("did it pick the right skill?").
4. **Script execution** only inside the sandbox; honour `allowed-tools`.
5. **Compatibility mode**: read Claude Code and Codex skill locations so users' existing skills work unchanged [SKL-04, SKL-06].
6. **Skill eval kit**: for each skill, a few trigger prompts (should and shouldn't activate) and outcome checks. Feed failing triggers into description optimisation (Ch. 04).
7. **`skill-create` flow**: after a successful session, propose a skill draft (diff) for user review [SKL-08, SKL-05].

## Open questions
- Should skills be able to declare required MCP servers or models? The spec allows extension fields. Watch for conventions.
- How do we trust and sign third-party skills? See Ch. 06/09 on supply chain.

<!-- SOURCES:SKL -->
## Sources

| ID | Source | Org | Date | Priority |
|----|--------|-----|------|----------|
| SKL-01 | [Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills) | Anthropic (Zhang, Lazuka, Murag) | 2025-10-16 | Must read |
| SKL-02 | [Agent Skills specification (open standard)](https://agentskills.io/specification) | agentskills.io (Anthropic-originated) | 2025-12 | Must read |
| SKL-03 | [Agent Skills (open standard commentary)](https://simonwillison.net/2025/Dec/19/agent-skills/) | Simon Willison | 2025-12-19 | Optional |
| SKL-04 | [Codex skills](https://developers.openai.com/codex/skills) | OpenAI | current | Should read |
| SKL-05 | [anthropics/skills (example skills repo)](https://github.com/anthropics/skills) | Anthropic | 2025-10 / current | Should read |
| SKL-06 | [Claude Code skills docs](https://docs.claude.com/en/docs/claude-code/skills) | Anthropic | current | Should read |
| SKL-07 | [AGENTS.md](https://agents.md) | OpenAI -> Agentic AI Foundation | 2025-08 | Must read |
| SKL-08 | [Voyager: An Open-Ended Embodied Agent with LLMs](https://arxiv.org/abs/2305.16291) | Wang et al. (NVIDIA, Caltech et al.) | 2023-05-25 | Should read |
<!-- /SOURCES -->
