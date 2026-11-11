// The interactive terminal UI (ADR-0005): a prompt at the bottom, the conversation printed
// into normal scrollback above it. Runs the same engine as `teh -p`, one runAgent per prompt,
// with the conversation carried over.
import {
  type Access,
  type AgentEvent,
  type AgentOptions,
  type AgentResult,
  addUsage,
  emptyUsage,
  expandSkill,
  type HookRunner,
  type Item,
  loadSession,
  type PermissionConfig,
  type PermissionMode,
  ProviderError,
  parseRules,
  parseSlash,
  runAgent,
  type SessionLog,
  type Skill,
  similarNames,
  suggestRule,
  type Usage,
} from "@everything-harness/core";
import { Editor } from "./editor";
import { type Key, KeyParser } from "./keys";
import { InlineRenderer } from "./renderer";
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON, HIDE_CURSOR, SHOW_CURSOR, type TerminalIo } from "./terminal";
import { makeStyle, type Style, wrap } from "./text";

export type TuiOptions = {
  terminal: TerminalIo;
  color: boolean;
  // What runAgent needs, minus the per-prompt parts.
  agent: Omit<AgentOptions, "prompt" | "history" | "ask" | "onEvent" | "signal" | "session" | "checkpoint" | "slash">;
  modelLabel: string;
  session: SessionLog;
  // Starts a fresh session for /clear.
  newSession: () => SessionLog;
  history?: Item[];
  initialPrompt?: string;
  checkpoint?: (step: { first: boolean; title: string }, prompt: string) => Promise<string>;
  // Run when the UI asks for approval: the Notification hook, a bell.
  onNotify?: (message: string) => void;
  // Hooks for a session (ADR-0016); called again after /clear with the new session.
  hooksFor?: (session: SessionLog) => HookRunner;
  resumed?: boolean;
  // Animate the spinner. Off in tests, where output must be deterministic.
  animate?: boolean;
  escapeDelayMs?: number;
  // Injected for tests.
  run?: (opts: AgentOptions) => Promise<AgentResult>;
};

type Approval = {
  tool: string;
  access: Access;
  reason: string;
  suggestion?: string;
  resolve: (ok: boolean) => void;
};

const MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];
const BUILTIN_COMMANDS: [string, string][] = [
  ["help", "Show keys and commands"],
  ["clear", "Start a new conversation"],
  ["cost", "Show token usage for this session"],
  ["mode", "Cycle the permission mode (also Shift+Tab)"],
  ["exit", "Quit (also Ctrl+D)"],
];
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TuiApp {
  private readonly style: Style;
  private readonly renderer: InlineRenderer;
  private readonly keys = new KeyParser();
  private readonly editor = new Editor();
  private history: Item[];
  private session: SessionLog;
  private readonly permissions: PermissionConfig;
  private running: { abort: AbortController; started: number; prompt: string } | undefined;
  private approval: Approval | undefined;
  private queue: string[] = [];
  private partial = ""; // streaming assistant text not yet committed
  private textStarted = false;
  private usage: Usage = emptyUsage();
  private lastInput = 0; // input tokens of the latest turn: the context in use
  private note = ""; // one-line message under the prompt, cleared on the next key
  private exitArmed = false;
  private sessionStart: "startup" | "resume" | "clear" | undefined;
  private hooks: HookRunner | undefined;
  private frame = 0;
  private escTimer: ReturnType<typeof setTimeout> | undefined;
  private spin: ReturnType<typeof setInterval> | undefined;
  private finished: ((code: number) => void) | undefined;
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly opts: TuiOptions) {
    this.style = makeStyle(opts.color);
    this.renderer = new InlineRenderer(opts.terminal);
    this.history = opts.history ?? [];
    this.session = opts.session;
    this.hooks = opts.hooksFor?.(this.session);
    this.sessionStart = opts.resumed ? "resume" : "startup";
    // Mutated by Shift+Tab; runAgent reads the mode at every tool call.
    this.permissions = { ...opts.agent.permissions, allow: [...opts.agent.permissions.allow] };
  }

  get currentSession(): SessionLog {
    return this.session;
  }

  get currentHooks(): HookRunner | undefined {
    return this.hooks;
  }

  // Runs until the person quits. Returns the exit code.
  async start(): Promise<number> {
    const t = this.opts.terminal;
    t.setRawMode(true);
    t.write(BRACKETED_PASTE_ON + HIDE_CURSOR);
    this.cleanups.push(t.onData((d) => this.onData(d)));
    this.cleanups.push(t.onResize(() => this.renderer.redraw()));
    this.renderer.commit(this.banner());
    if (this.history.length)
      this.renderer.commit([
        this.style.dim(`  resumed: ${this.countPrompts()} earlier prompt(s) in this conversation`),
        "",
      ]);
    const done = new Promise<number>((resolve) => {
      this.finished = resolve;
    });
    this.render();
    if (this.opts.initialPrompt?.trim()) this.submit(this.opts.initialPrompt);
    const code = await done;
    this.teardown();
    return code;
  }

  private teardown() {
    clearInterval(this.spin);
    clearTimeout(this.escTimer);
    for (const c of this.cleanups.splice(0)) c();
    this.renderer.flush();
    this.renderer.clear();
    const t = this.opts.terminal;
    if (this.countPrompts())
      t.write(
        `${this.style.dim(`Continue this conversation with: teh -c   (or teh -r ${this.session.id.slice(0, 13)})`)}\r\n`,
      );
    t.write(BRACKETED_PASTE_OFF + SHOW_CURSOR);
    t.setRawMode(false);
  }

  private quit(code = 0) {
    this.running?.abort.abort();
    this.approval?.resolve(false);
    this.finished?.(code);
  }

  // --- Input -------------------------------------------------------------------------

  private onData(data: string) {
    clearTimeout(this.escTimer);
    for (const k of this.keys.feed(data)) this.onKey(k);
    if (this.keys.pendingEscape) {
      this.escTimer = setTimeout(() => {
        for (const k of this.keys.flushEscape()) this.onKey(k);
      }, this.opts.escapeDelayMs ?? 50);
    }
  }

  onKey(k: Key) {
    if (k.kind !== "ctrlC") this.exitArmed = false;
    if (this.approval) return this.onApprovalKey(k);
    if (k.kind === "ctrlC") {
      if (this.running) return this.interrupt();
      if (this.editor.text) {
        this.editor.set("");
        return this.render();
      }
      if (this.exitArmed) return this.quit(0);
      this.exitArmed = true;
      this.note = "Press Ctrl+C again to exit";
      return this.render();
    }
    if (k.kind === "escape") {
      if (this.running) return this.interrupt();
      return;
    }
    if (k.kind === "ctrlD" && !this.editor.text) return this.quit(0);
    if (k.kind === "shiftTab") return this.cycleMode();
    if (k.kind === "ctrlL") return this.renderer.redraw();
    if (k.kind === "tab") {
      const first = this.completions()[0];
      if (first) this.editor.set(`/${first[0]} `);
      return this.render();
    }
    this.note = "";
    const r = this.editor.handle(k);
    if (r?.submit !== undefined) this.submit(r.submit);
    else this.render();
  }

  private onApprovalKey(k: Key) {
    const a = this.approval as Approval;
    const answer = (ok: boolean, always = false) => {
      this.approval = undefined;
      const label = ok
        ? this.style.green(always ? "✓ allowed for this session" : "✓ allowed")
        : this.style.red("✗ not allowed");
      this.renderer.commit([`  ${label}`]);
      if (always && a.suggestion) this.permissions.allow.push(...parseRules([a.suggestion], "this session"));
      a.resolve(ok);
      this.render();
    };
    if (k.kind === "char") {
      const c = k.text.toLowerCase();
      if (c === "y" || c === "1") return answer(true);
      if ((c === "a" || c === "2") && a.suggestion) return answer(true, true);
      if (c === "n" || c === "3") return answer(false);
    }
    if (k.kind === "enter") return answer(true);
    if (k.kind === "escape" || k.kind === "ctrlC") return answer(false);
  }

  private cycleMode() {
    const i = MODES.indexOf(this.permissions.mode);
    this.permissions.mode = MODES[(i + 1) % MODES.length] as PermissionMode;
    this.render();
  }

  private completions(): [string, string][] {
    const t = this.editor.text;
    if (!t.startsWith("/") || /\s/.test(t)) return [];
    const q = t.slice(1).toLowerCase();
    const skills: [string, string][] = (this.opts.agent.skills ?? [])
      .filter((s) => s.userInvocable)
      .map((s) => [s.name, s.description]);
    return [...BUILTIN_COMMANDS, ...skills].filter(([n]) => n.toLowerCase().startsWith(q)).slice(0, 6);
  }

  // --- Prompts -----------------------------------------------------------------------

  private submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return this.render();
    if (this.running) {
      this.queue.push(trimmed);
      return this.render();
    }
    const slash = parseSlash(trimmed);
    if (slash && this.builtin(slash.name, slash.args)) return;
    let prompt = trimmed;
    if (slash) {
      const skill = (this.opts.agent.skills ?? []).find((s: Skill) => s.name === slash.name && s.userInvocable);
      if (!skill) {
        const near = similarNames(slash.name, this.opts.agent.skills ?? []);
        this.renderer.commit([
          this.style.red(
            `  no command named /${slash.name}${near.length ? `; did you mean ${near.map((n) => `/${n}`).join(", ")}?` : ""}`,
          ),
          this.style.dim("  /help lists commands"),
        ]);
        return this.render();
      }
      prompt = expandSkill(skill, slash.args);
    }
    void this.runPrompt(trimmed, prompt, slash ?? undefined);
  }

  // Built-in slash commands. Returns false when the name is not one.
  private builtin(name: string, _args: string): boolean {
    const s = this.style;
    switch (name) {
      case "exit":
      case "quit":
        this.quit(0);
        return true;
      case "help":
        this.renderer.commit([
          "",
          s.bold("Keys"),
          "  Enter send · Shift+Enter, Alt+Enter or \\ then Enter: new line · ↑/↓ history",
          "  Esc interrupt · Shift+Tab cycle permission mode · Ctrl+C clear, twice to quit · Ctrl+D quit",
          "  Typing while teh works queues your message for when it finishes.",
          s.bold("Commands"),
          ...BUILTIN_COMMANDS.map(([n, d]) => `  /${n.padEnd(10)} ${d}`),
          ...(this.opts.agent.skills ?? [])
            .filter((k) => k.userInvocable)
            .map((k) => `  /${k.name.padEnd(10)} ${s.dim(k.description.replace(/\s+/g, " ").slice(0, 70))}`),
          "",
        ]);
        this.render();
        return true;
      case "clear":
        this.history = [];
        this.session = this.opts.newSession();
        this.hooks = this.opts.hooksFor?.(this.session);
        this.sessionStart = "clear";
        this.usage = emptyUsage();
        this.lastInput = 0;
        this.renderer.commit(["", s.dim("  (new conversation)"), ""]);
        this.render();
        return true;
      case "cost": {
        const u = this.usage;
        this.renderer.commit([
          s.dim(
            `  tokens this session: ${fmt(u.input)} in (${fmt(u.cachedRead)} cached) · ${fmt(u.output)} out · context now ${fmt(this.lastInput)}`,
          ),
        ]);
        this.render();
        return true;
      }
      case "mode":
        this.cycleMode();
        return true;
      default:
        return false;
    }
  }

  private async runPrompt(shown: string, prompt: string, slash: { name: string; args: string } | undefined) {
    const s = this.style;
    this.renderer.commit([
      "",
      ...shown.split("\n").map((l, i) => `${i === 0 ? s.bold(s.cyan("›")) : " "} ${s.bold(l)}`),
      "",
    ]);
    const abort = new AbortController();
    this.running = { abort, started: Date.now(), prompt };
    this.textStarted = false;
    this.startSpinner();
    this.render();
    const run = this.opts.run ?? runAgent;
    try {
      const res = await run({
        ...this.opts.agent,
        permissions: this.permissions,
        prompt,
        history: this.history,
        session: this.session,
        signal: abort.signal,
        ...(slash ? { slash } : {}),
        ...(this.hooks ? { hooks: this.hooks } : {}),
        ...(this.hooks && this.sessionStart ? { hookSessionStart: this.sessionStart } : {}),
        ask: (req) => this.ask(req),
        onEvent: (e) => this.onEvent(e),
        ...(this.opts.checkpoint
          ? {
              checkpoint: (step: { first: boolean; title: string }) =>
                this.opts.checkpoint?.(step, prompt) ?? Promise.resolve(""),
            }
          : {}),
      });
      this.flushText();
      this.history = res.items;
      if (res.stopReason === "max_turns") this.renderer.commit([s.yellow(`  stopped after ${res.turns} turns`)]);
      if (res.stopReason === "hook_blocked" || res.stopReason === "hook_stopped") this.history = this.reload();
    } catch (e) {
      this.flushText();
      this.history = this.reload();
      if (abort.signal.aborted)
        this.renderer.commit([s.red("  ⎿ Interrupted") + s.dim(" · tell teh what to do instead")]);
      else if (e instanceof ProviderError)
        this.renderer.commit([s.red(`  ✗ ${e.message}`), ...(e.hint ? [s.dim(`    fix: ${e.hint}`)] : [])]);
      else this.renderer.commit([s.red(`  ✗ ${(e as Error).message}`)]);
    } finally {
      this.sessionStart = undefined;
      this.running = undefined;
      this.stopSpinner();
    }
    this.render();
    if (this.queue.length) {
      const next = this.queue.splice(0).join("\n\n");
      this.submit(next);
    }
  }

  // The conversation as the session log has it: what survived an interrupt or a refusal.
  private reload(): Item[] {
    try {
      return loadSession(this.session.path).items;
    } catch {
      return this.history;
    }
  }

  private interrupt() {
    if (!this.running) return;
    this.running.abort.abort();
    this.queue = [];
    this.render();
  }

  private ask(req: { tool: string; access: Access; reason: string }): Promise<boolean> {
    this.flushText();
    const suggestion = suggestRule(req.tool, req.access);
    this.opts.onNotify?.(`teh needs your permission to use ${req.tool}`);
    this.opts.terminal.write("\x07");
    return new Promise((resolve) => {
      this.approval = { ...req, ...(suggestion ? { suggestion } : {}), resolve };
      this.render();
    });
  }

  // --- Agent events ------------------------------------------------------------------

  private onEvent(e: AgentEvent) {
    const s = this.style;
    switch (e.type) {
      case "text_delta":
        this.partial += e.text;
        this.commitCompleteLines();
        break;
      case "tool_call":
        this.flushText();
        this.renderer.commit([`${s.green("●")} ${s.bold(e.summary ?? e.name)}`]);
        break;
      case "tool_result":
        this.renderer.commit(this.resultLines(e.name, e.content, e.isError));
        break;
      case "approval":
        if (e.behavior === "deny" && !e.reason.startsWith("approved")) {
          // Asked-and-refused shows in the approval prompt already.
          if (!e.reason.endsWith("needs approval")) this.renderer.commit([s.red(`  ✗ ${e.reason}`)]);
        }
        break;
      case "hook":
        this.renderer.commit([s.yellow(`  ${e.event} hook: ${e.message}`)]);
        break;
      case "warning":
        this.renderer.commit([s.yellow(`  ! ${e.message}`)]);
        break;
      case "turn_end":
        this.usage = addUsage(this.usage, e.usage);
        if (e.usage.input) this.lastInput = e.usage.input + e.usage.cachedRead + e.usage.output;
        break;
      default:
        break;
    }
    this.render();
  }

  // Finished lines of the reply go to scrollback as they arrive; the last, partial line
  // stays in the live area.
  private commitCompleteLines() {
    const nl = this.partial.lastIndexOf("\n");
    if (nl < 0) return;
    const done = this.partial.slice(0, nl);
    this.partial = this.partial.slice(nl + 1);
    this.renderer.commit(this.textLines(done));
  }

  private flushText() {
    if (this.partial) this.renderer.commit(this.textLines(this.partial));
    this.partial = "";
  }

  private textLines(text: string): string[] {
    const s = this.style;
    let fence = false;
    return text.split("\n").map((line) => {
      let out: string;
      if (/^\s*```/.test(line)) {
        fence = !fence;
        out = s.gray(line);
      } else if (fence) out = s.cyan(line);
      else out = inlineMarkdown(line, s);
      const prefix = this.textStarted ? "  " : `${s.bold("●")} `;
      if (line.trim()) this.textStarted = true;
      return prefix + out;
    });
  }

  private resultLines(name: string, content: string, isError: boolean): string[] {
    const s = this.style;
    if (content.startsWith("Permission denied") || content.startsWith("Blocked by a PreToolUse hook")) return [];
    const lines = content.split("\n");
    const head = (lines.find((l) => l.trim() && l !== "[stderr]") ?? "").slice(0, 160);
    if (isError) return [`  ${s.red(`⎿ ${head}`)}`];
    if ((name === "Edit" || name === "Write") && /^(edited|overwrote) /.test(head)) {
      const diff = lines.slice(1).filter((l) => /^[ +-] /.test(l) || /^ {2}…/.test(l));
      const shown = diff.slice(0, 14).map((l) => {
        if (l.startsWith("+ ")) return `    ${s.green(l)}`;
        if (l.startsWith("- ")) return `    ${s.red(l)}`;
        return `    ${s.dim(l)}`;
      });
      const more = diff.length > 14 ? [s.dim(`    … ${diff.length - 14} more lines`)] : [];
      return [`  ${s.dim("⎿")} ${head.replace(/\. Check this is what you meant:$/, "")}`, ...shown, ...more];
    }
    if (name === "Read") return [`  ${s.dim(`⎿ ${lines.length} line${lines.length === 1 ? "" : "s"}`)}`];
    const n = lines.length;
    return [`  ${s.dim(`⎿ ${head}${n > 1 ? ` (+${n - 1} lines)` : ""}`)}`];
  }

  // --- Drawing -----------------------------------------------------------------------

  private startSpinner() {
    if (this.opts.animate === false) return;
    this.spin = setInterval(() => {
      this.frame++;
      this.render();
    }, 100);
  }

  private stopSpinner() {
    clearInterval(this.spin);
    this.spin = undefined;
  }

  private render() {
    const s = this.style;
    const cols = this.opts.terminal.columns();
    const lines: string[] = [];
    if (this.partial) {
      const prefix = this.textStarted ? "  " : `${s.bold("●")} `;
      lines.push(...wrap(prefix + inlineMarkdown(this.partial, s), cols - 1));
    }
    if (this.approval) {
      const a = this.approval;
      lines.push(
        "",
        s.yellow(`╭ Allow ${a.access.summary}?`),
        s.dim(`│ ${a.reason}`),
        `│ ${s.bold("y")} yes   ${a.suggestion ? `${s.bold("a")} yes, and allow ${s.cyan(a.suggestion)} for this session   ` : ""}${s.bold("n")} no ${s.dim("(esc)")}`,
        s.yellow("╰"),
      );
    } else {
      if (this.running) {
        const secs = Math.floor((Date.now() - this.running.started) / 1000);
        const spin = this.opts.animate === false ? "✻" : (SPINNER[this.frame % SPINNER.length] as string);
        lines.push(`${s.magenta(spin)} ${s.dim(`Working… (${secs}s · esc to interrupt)`)}`);
      }
      for (const q of this.queue) lines.push(s.dim(`  queued: ${q.replace(/\s+/g, " ").slice(0, cols - 14)}`));
      lines.push(s.gray("─".repeat(Math.max(10, cols - 1))));
      lines.push(...this.editor.render(s, cols - 1, this.running ? "" : "Ask teh anything · /help for commands"));
      lines.push(s.gray("─".repeat(Math.max(10, cols - 1))));
      const completions = this.completions();
      if (completions.length) {
        for (const [n, d] of completions)
          lines.push(
            `  ${s.cyan(`/${n}`.padEnd(16))} ${s.dim(d.replace(/\s+/g, " ").slice(0, Math.max(10, cols - 22)))}`,
          );
      } else lines.push(this.status(cols));
      if (this.note) lines.push(s.dim(`  ${this.note}`));
    }
    this.renderer.setLive(lines);
  }

  private status(cols: number): string {
    const s = this.style;
    const mode = this.permissions.mode;
    const modeText =
      mode === "acceptEdits"
        ? s.magenta("⏵⏵ accept edits on")
        : mode === "plan"
          ? s.cyan("⏸ plan mode on")
          : mode === "bypassPermissions"
            ? s.red("bypass permissions on")
            : s.dim("? for help · ⇧⇥ modes");
    const ctx = this.lastInput ? ` · ${fmt(this.lastInput)} context` : "";
    const right = s.dim(`${this.opts.modelLabel}${ctx}`);
    const left = `  ${modeText}`;
    const gap = Math.max(2, cols - 1 - visible(left) - visible(right));
    return left + " ".repeat(gap) + right;
  }

  private banner(): string[] {
    const s = this.style;
    return [
      `${s.bold("teh")} ${s.dim("· The Everything Harness")}`,
      s.dim(`  ${this.opts.modelLabel} · ${this.opts.agent.cwd}`),
      s.dim("  /help for keys and commands · Esc interrupts · Ctrl+D quits"),
      "",
    ];
  }

  private countPrompts(): number {
    return this.history.filter((i) => i.kind === "text" && i.role === "user").length;
  }
}

const visible = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "").length;

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// **bold**, `code` and # headings; enough to read a reply, without a Markdown parser.
function inlineMarkdown(line: string, s: Style): string {
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return s.bold(h[2] as string);
  return line
    .replace(/\*\*([^*]+)\*\*/g, (_, t: string) => s.bold(t))
    .replace(/`([^`]+)`/g, (_, t: string) => s.cyan(t));
}

export async function runTui(opts: TuiOptions): Promise<number> {
  return new TuiApp(opts).start();
}
