# Permissions and the sandbox

`teh` asks before every change by default (ADR-0008). Reading the project and read-only commands such as `ls`, `cat`, `grep`, `sed -n 1,20p` and `git status/log/diff` run without asking. Headless mode cannot ask, so it denies everything else and prints the rule that would allow it:
- `--permission-mode acceptEdits` allows file edits inside the workspace.
- `--allowedTools 'Bash(npm test:*)'` allows `npm test` with any arguments. `'Bash(npm test)'` allows only that exact command.
- `--disallowedTools 'Bash(git push:*)' 'Read(.env)'` blocks those. Deny rules win over everything, including `bypassPermissions`.
- `--allowedTools 'WebFetch(domain:docs.rs)'` lets the model fetch from that site (`domain:*.rust-lang.org` covers subdomains), and `WebSearch` lets it search. Network requests ask first in every mode, since they can carry data out.

Rules apply to each part of a command: `npm test && git status` runs with only `Bash(npm test:*)` allowed, but `npm test; rm -rf ~` still asks. A command the parser can't read fully, such as one with `$(…)` or a here-doc, always asks (ADR-0003).

Rules can also live in settings files, in Claude Code's format: `{"permissions": {"allow": [...], "ask": [...], "deny": [...]}}`.
- **Where:** `~/.teh/settings.json` and `~/.claude/settings.json` for you, and `.teh/settings.json` or `.claude/settings.json` (plus `settings.local.json`) for a project.
- **Trust:** a cloned repo's allow rules, and its skills' `allowed-tools`, are ignored until you run `teh trust` in it. Its deny and ask rules apply at once.
- **Protected folders:** writes inside `.git`, `.teh`, `.claude` and `.agents` always ask.
- **Checking:** `teh permissions` shows every rule in effect and where it comes from.

Shell commands also run in an OS sandbox on macOS (Seatbelt) and Linux (bubblewrap; install the `bubblewrap` package):
- **Commands that ran without asking** can't write anything outside the temp folder, have no network, and can't see `~/.ssh`, `~/.aws` and other credential folders.
- **Commands you or a rule allowed** can write only inside the project, the temp folder and package caches. They have network access unless you set `"sandbox": {"network": false}`.
- **Always read-only:** `.teh`, `.claude`, `.agents`, `.git/hooks` and `.git/config`.
- **Settings:** add writable folders with `"sandbox": {"allowWrite": ["~/other"]}`.
- **Turning it off:** `--sandbox off`. `--sandbox on` refuses to run without one.
- **Windows:** no sandbox yet.
