# 0003 — Permission and sandbox model

- **Status:** Proposed
- **Date:** 2026-11-04
- **Deciders:** Samuel Shine
- **Related research:** `docs/research/10-terminal-harness.md` §4, `docs/research/11-competitive-landscape.md` §2–3, ADR-0008, ADR-0010, ADR-0015; sources [TRM-04], [TRM-13], [TRM-14], [TRM-19], [CMP-07], [CMP-10], [CMP-13], [CMP-14]

## Context
ADR-0008 settled *when* `teh` asks: before every action that changes something. Two things are still missing:
- **A way to tell which shell commands are read-only.** The interim engine asks before every command, even `ls` and `git status`, and an allow rule must spell out the whole command. Users get prompt fatigue and start approving without reading.
- **Something that holds even after the user says yes.** An approved command can still write anywhere or reach the network.

The research is clear about how this goes wrong:
- **Prefix matching.** Matching rules by the first word of a command is the recurring bypass. Gemini CLI's `grep …; exfil` hid a second command after an allowed one [CMP-07], and several Claude Code CVEs had the same root cause [CMP-13, CMP-14].
- **Self-modifying permissions.** An agent that could edit its own permission config granted itself access [CMP-13].
- **Untrusted repos.** A cloned repo can ship settings, skills and hooks. Its allow rules must not apply before the user trusts the folder.
- **Bypass flags.** Malware ran installed agents with their bypass flags to hunt for secrets [CMP-10].

## Options considered
For classifying shell commands:
1. **Prefix match on the raw string.** Simple, but it is the bug class above.
2. **Full bash parser (tree-sitter-bash or a port of mvdan/sh).** Exact, but it is a large dependency for a question we answer conservatively anyway.
3. **A small conservative parser** (chosen). It understands the subset that matters: words, quotes, escapes, `;`, `&&`, `||`, `|`, `&`, newlines and redirections. Anything else, such as `$(…)`, backticks, subshells, `<(…)`, here-docs, `$VAR` in a command position, or functions, makes the command *opaque*. An opaque command can only be allowed by an exact-match rule or by bypass mode, and is never auto-allowed.

For the layer underneath approval:
1. **No sandbox.** This relies on approval alone.
2. **OS sandbox for shell commands** (chosen): Seatbelt (`sandbox-exec`) on macOS and bubblewrap on Linux, as Codex and Anthropic's sandbox-runtime do [TRM-13, TRM-14, TRM-19]. Windows waits for ADR-0013.
3. **Containers.** Strongest, but too heavy as a default for a terminal tool.

## Decision
**1. Two separate layers:**
- **Approval:** deny → ask → allow, as ADR-0008.
- **Sandbox:** limits even approved commands.

**2. Rules use Claude Code's syntax (ADR-0010).** They come from `--allowedTools` and `--disallowedTools`, and from `permissions.allow`, `permissions.ask` and `permissions.deny` in these files:
- user: `~/.teh/settings.json`, `~/.claude/settings.json`;
- project: `.teh/settings.json`, `.teh/settings.local.json`, `.claude/settings.json`, `.claude/settings.local.json`.

Supported forms:

| Rule | Matches |
|---|---|
| `Bash` | Any command |
| `Bash(npm test)` | Exactly `npm test` |
| `Bash(npm test:*)`, `Bash(npm test *)` | `npm test` followed by any arguments |
| `Bash(git * --stat)` | `*` matches any run of words |
| `Edit`, `Write` | Any file change |
| `Edit(src/**)` | Changes under `src/`. `Edit` rules cover every write tool. Paths are relative to the project root; `~/` means home and `//` means an absolute path. |
| `Read(.env)`, `Read(**/*.pem)` | Reads of those paths. Mainly for deny rules. |
| `Grep`, `Glob`, `Skill`, … | That tool |

Bash rules are matched **per simple command**, after parsing:
- `npm test && git status` is allowed only if *each* part is allowed, either by a rule or as read-only.
- A deny rule matching *any* part denies the whole command.
- For an opaque command, a deny rule whose first word appears anywhere in it denies it. This errs on the side of blocking.

**3. Read-only commands run without asking.** A command counts as read-only only if every part satisfies all of these:
- It is on a fixed list: `ls`, `cat`, `head`, `tail`, `wc`, `grep`, `rg`, `find`, `tree`, `diff`, `stat`, `file`, `du`, `pwd`, `echo`, `which`, `sort`, `uniq`, `cut`, `jq`, …, and read-only `git` subcommands such as `status`, `log`, `diff`, `show`, `blame` and `ls-files`.
- It uses none of the flags that make a listed command write or execute: `find -exec/-delete`, `sort -o`, `rg --pre`, `git log --output`, `git -c`, `git branch <name>`, …
- It does not set environment variables in front of the command (`GIT_EXTERNAL_DIFF=… git diff`).
- It does not redirect output to a file. `2>&1` and `>/dev/null` are fine.
- Every argument that looks like a path resolves inside the workspace or a read root.

`cd` inside the workspace and the wrappers `timeout`, `nice` and `time` are looked through.

**4. Protected paths always ask, except in bypass mode:**
- `.git/`, `.teh/`, `.claude/` and `.agents/` inside the workspace;
- `~/.teh` and `~/.claude`.

This holds under `acceptEdits` and despite allow rules, so the agent cannot quietly rewrite its own permissions, hooks or skills.

**5. Workspace trust:**
- Project-level `allow` rules, and the `allowed-tools` grants of project skills, apply only after the user runs `teh trust` in that project. Trusted folders are recorded in `~/.teh/trusted-projects.json`.
- Project `deny` and `ask` rules apply immediately.
- When untrusted allow rules are ignored, `teh` says so once and names the command that trusts the folder.

**6. Skill `allowed-tools`:** while a skill is loaded, its `allowed-tools` act as extra allow rules for the rest of that session. User-level skills get this always; project skills only in a trusted folder. Deny rules still win.

**7. The OS sandbox comes in a follow-up change.** Shell commands run with:
- writes limited to the workspace roots and the temp directory;
- protected paths read-only;
- network off unless allowed;

with `--sandbox off` as the escape hatch. Until then, the engine is approval-only and the README says so.

## Consequences
- **Fewer prompts.** `ls`, `git status`, `grep -r foo src` and `npm test && git diff` (with `Bash(npm test:*)` allowed) no longer ask. Anything the parser doesn't understand still asks, so the list can grow safely over time.
- **A regression corpus is needed.** The read-only classifier and the parser need a table of known-safe and known-bypass commands, and every reported bypass becomes a test case.
- **Residual risk from repo configuration.** Some "read-only" programs can run commands configured by the repo itself: git's `core.fsmonitor`, `core.pager` and `diff.external`, and `textconv` filters. A malicious repo could use these. Workspace trust and the sandbox (step 7) are the defences, and this ADR does not claim more.
- **Path-like arguments are judged by their text.** `cat ../secret` asks; `cat foo` is assumed to be inside the workspace.
- **Revisit when:**
  - the sandbox lands, at which point read-only classification could relax for sandboxed commands;
  - telemetry shows approval fatigue persisting (ADR-0008).
