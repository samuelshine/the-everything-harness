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
import { FullscreenRenderer } from "./fullscreen";
import { type Key, KeyParser } from "./keys";
import { type ConfigItem, PANEL_TABS, type PanelContent, type PanelTab, renderPanel } from "./panel";
import { InlineRenderer, type Screen } from "./renderer";
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON, HIDE_CURSOR, SHOW_CURSOR, type TerminalIo } from "./terminal";
import { makeStyle, type Style, wrap } from "./text";
import { resultLines, toolHeader, toolHeaderFromCall } from "./toolview";

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
  // Full screen on the alternate screen (ADR-0018, the default in the CLI), or inline (ADR-0005).
  fullscreen?: boolean;
  // Where each session's transcript is cached, so a resumed session redraws as it looked.
  transcript?: { load(sessionId: string): string[] | undefined; append(sessionId: string, lines: string[]): void };
  // How long that cache is kept, for the note shown when it has expired.
  cacheDays?: number;
  // Saves a setting changed on the panel's Config tab: in ~/.teh/settings.json ("user") or
  // in this project's .teh/settings.local.json ("project"). `undefined` removes the key.
  saveSetting?: (scope: "user" | "project", key: string, value: unknown) => void;
  // What those files say now, for the Config tab.
  settings?: SavedSettings;
  // Installed models the Config tab can switch to ("ollama:qwen2.5:14b"), and how to start one.
  models?: string[];
  useModel?: (label: string) => Promise<ModelPick>;
  // Extra rows for the settings panel's Status tab (project folder, trust, MCP servers…).
  statusInfo?: [string, string][];
  // The model's context window, for the Usage tab.
  contextWindow?: number;
  // Set when no model is pinned (ADR-0014): called with the first prompt of each session to
  // choose the model for it. The choice then holds for the whole session.
  pickModel?: (prompt: string, planMode: boolean) => Promise<ModelPick>;
  // Animate the spinner. Off in tests, where output must be deterministic.
  animate?: boolean;
  escapeDelayMs?: number;
  // Injected for tests.
  run?: (opts: AgentOptions) => Promise<AgentResult>;
};

export type SavedSettings = {
  model?: { user?: string | undefined; project?: string | undefined };
  defaultMode?: { user?: PermissionMode | undefined; project?: PermissionMode | undefined };
  cleanupPeriodDays?: number | undefined;
  checkpointRetentionDays?: number | undefined;
};

export type ModelPick = {
  provider: AgentOptions["provider"];
  model: string;
  label: string;
  contextWindow?: number;
  // Why this model, e.g. "S: short question".
  reason: string;
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
  ["btw", "Ask a side question; it is not added to the conversation"],
  ["status", "Settings panel: model, folder and session"],
  ["config", "Settings panel: change settings"],
  ["usage", "Settings panel: tokens and context used"],
  ["cost", "Same as /usage"],
  ["mode", "Cycle the permission mode (also Shift+Tab)"],
  ["exit", "Quit (also Ctrl+D)"],
];
const SCROLL_KEYS: Partial<Record<Key["kind"], ["line" | "page" | "end", 1 | -1]>> = {
  pageUp: ["page", 1],
  pageDown: ["page", -1],
  scrollUp: ["line", 1],
  scrollDown: ["line", -1],
  top: ["end", 1],
  bottom: ["end", -1],
};
const CACHE_DAY_CHOICES = [1, 3, 7, 14, 30];
const SESSION_DAY_CHOICES = [7, 14, 30, 60, 90];
const CHECKPOINT_DAY_CHOICES = [undefined, 7, 14, 30, 90];
const START_MODES: PermissionMode[] = ["default", "acceptEdits", "plan"];
const days = (n: number | undefined, none = "forever") => (n === undefined ? none : `${n} day${n === 1 ? "" : "s"}`);
// The value after `current` in `choices`, wrapping round.
function next<T>(choices: T[], current: T): T {
  return choices[(choices.indexOf(current) + 1) % choices.length] as T;
}
const BTW_SYSTEM =
  "The user is asking a quick side question while working with a coding agent. Answer it briefly and directly from the conversation so far and what you know. You have no tools here; do not try to call any.";
const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export class TuiApp {
  private readonly style: Style;
  private renderer: Screen;
  private fullscreen: boolean;
  // Everything committed to the transcript, so the screen can be switched mid-session.
  private shownLines: string[] = [];
  private saved: SavedSettings;
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
  private agent: TuiOptions["agent"];
  private modelLabel: string;
  private contextWindow: number | undefined;
  private modelReason = ""; // why the model was chosen, when teh chose it
  private picked = false;
  private panel: { tab: PanelTab; selected: number } | undefined;
  private readonly callArgs = new Map<string, unknown>();
  private block: "none" | "text" | "tool" = "none"; // what was printed last in this reply
  private cacheDays: number;
  private side = 0; // /btw questions still being answered
  private explore: { model: string; last: string; uses: number } | undefined; // a running subagent
  private readonly startedAt = Date.now();

  constructor(private readonly opts: TuiOptions) {
    this.style = makeStyle(opts.color);
    this.fullscreen = opts.fullscreen ?? false;
    this.renderer = this.makeRenderer(this.fullscreen);
    this.saved = structuredClone(opts.settings ?? {});
    this.agent = { ...opts.agent };
    this.modelLabel = opts.modelLabel;
    this.contextWindow = opts.contextWindow;
    this.history = opts.history ?? [];
    this.cacheDays = opts.cacheDays ?? 3;
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
    this.renderer.enter?.();
    this.commit(this.banner());
    if (this.history.length) this.showEarlier();
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
    this.renderer.leave?.();
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
    // Scrolling works in every state, approvals included.
    const scroll = SCROLL_KEYS[k.kind];
    if (scroll) {
      this.renderer.scroll?.(scroll[0], scroll[1]);
      return;
    }
    if (k.kind !== "ctrlC") this.exitArmed = false;
    if (this.approval) return this.onApprovalKey(k);
    if (this.panel) return this.onPanelKey(k);
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
      this.print([`  ${label}`]);
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

  // --- Settings panel -----------------------------------------------------------------

  private openPanel(tab: PanelTab) {
    this.panel = { tab, selected: 0 };
    this.editor.set("");
    this.render();
  }

  private onPanelKey(k: Key) {
    const p = this.panel as { tab: PanelTab; selected: number };
    const move = (by: number) => {
      const i = (PANEL_TABS.indexOf(p.tab) + by + PANEL_TABS.length) % PANEL_TABS.length;
      this.panel = { tab: PANEL_TABS[i] as PanelTab, selected: 0 };
    };
    const items = p.tab === "Config" ? this.configItems() : [];
    if (k.kind === "escape" || k.kind === "ctrlC" || (k.kind === "char" && k.text === "q")) this.panel = undefined;
    else if (k.kind === "ctrlD") return this.quit(0);
    else if (k.kind === "right" || k.kind === "tab") move(1);
    else if (k.kind === "left" || k.kind === "shiftTab") move(-1);
    else if (k.kind === "down" && items.length) p.selected = (p.selected + 1) % items.length;
    else if (k.kind === "up" && items.length) p.selected = (p.selected - 1 + items.length) % items.length;
    else if (k.kind === "enter" || (k.kind === "char" && k.text === " ")) items[p.selected]?.change?.();
    this.render();
  }

  private configItems(): ConfigItem[] {
    const save = this.opts.saveSetting;
    const set = (scope: "user" | "project", key: string, value: unknown) => {
      save?.(scope, key, value);
    };
    const models = this.opts.models ?? [];
    const saved = this.saved;
    const items: ConfigItem[] = [
      {
        section: "This session",
        label: "Permission mode",
        value: this.permissions.mode,
        hint: "also Shift+Tab",
        change: () => this.cycleMode(),
      },
      {
        label: "Model",
        value: this.modelLabel,
        hint: this.modelReason
          ? `chosen by teh (${this.modelReason})`
          : models.length > 1 && this.opts.useModel
            ? this.history.length
              ? "the next prompt re-reads the conversation"
              : this.opts.pickModel && !this.picked
                ? "or teh chooses on your first prompt"
                : ""
            : "no other installed model",
        ...(models.length > 1 && this.opts.useModel
          ? { change: () => void this.switchModel(next(models, this.modelLabel)) }
          : {}),
      },
      {
        label: "Screen",
        value: this.fullscreen ? "full screen" : "inline",
        hint: save ? "also saved as your default" : "",
        change: () => {
          this.setScreen(!this.fullscreen);
          set("user", "screen", this.fullscreen ? undefined : "inline");
        },
      },
    ];
    if (!save) return items;
    const auto = "teh chooses";
    const yours = "your default";
    items.push(
      {
        section: "This project · .teh/settings.local.json",
        label: "Model",
        value: saved.model?.project ?? yours,
        change: () => {
          const v = next([yours, ...models], saved.model?.project ?? yours);
          saved.model = { ...saved.model, project: v === yours ? undefined : v };
          set("project", "model", saved.model.project);
        },
      },
      {
        label: "Start in mode",
        value: saved.defaultMode?.project ?? yours,
        hint: saved.defaultMode?.project === "acceptEdits" ? "only while the folder is trusted" : "",
        change: () => {
          const v = next<string>([yours, ...START_MODES], saved.defaultMode?.project ?? yours);
          saved.defaultMode = { ...saved.defaultMode, project: v === yours ? undefined : (v as PermissionMode) };
          set("project", "permissions.defaultMode", saved.defaultMode.project);
        },
      },
      {
        section: "You · ~/.teh/settings.json",
        label: "Model",
        value: saved.model?.user ?? auto,
        change: () => {
          const v = next([auto, ...models], saved.model?.user ?? auto);
          saved.model = { ...saved.model, user: v === auto ? undefined : v };
          set("user", "model", saved.model.user);
        },
      },
      {
        label: "Start in mode",
        value: saved.defaultMode?.user ?? "default",
        change: () => {
          const v = next(START_MODES, saved.defaultMode?.user ?? "default");
          saved.defaultMode = { ...saved.defaultMode, user: v === "default" ? undefined : v };
          set("user", "permissions.defaultMode", saved.defaultMode.user);
        },
      },
      {
        label: "Keep screen cache",
        value: days(this.cacheDays),
        change: () => {
          this.cacheDays = next(CACHE_DAY_CHOICES, this.cacheDays);
          set("user", "cacheRetentionDays", this.cacheDays);
        },
      },
      {
        label: "Keep sessions",
        value: days(saved.cleanupPeriodDays ?? 30),
        change: () => {
          saved.cleanupPeriodDays = next(SESSION_DAY_CHOICES, saved.cleanupPeriodDays ?? 30);
          set("user", "cleanupPeriodDays", saved.cleanupPeriodDays === 30 ? undefined : saved.cleanupPeriodDays);
        },
      },
      {
        label: "Keep undo checkpoints",
        value: days(saved.checkpointRetentionDays),
        change: () => {
          saved.checkpointRetentionDays = next(CHECKPOINT_DAY_CHOICES, saved.checkpointRetentionDays);
          set("user", "checkpointRetentionDays", saved.checkpointRetentionDays);
        },
      },
    );
    return items;
  }

  private async switchModel(label: string) {
    const use = this.opts.useModel;
    if (!use) return;
    try {
      const pick = await use(label);
      this.agent = { ...this.agent, provider: pick.provider, model: pick.model };
      this.modelLabel = pick.label;
      this.contextWindow = pick.contextWindow ?? this.contextWindow;
      this.modelReason = "";
      this.picked = true;
    } catch (e) {
      this.note = `could not switch to ${label}: ${(e as Error).message}`;
    }
    this.render();
  }

  private panelContent(): PanelContent {
    const s = this.style;
    const u = this.usage;
    const window = this.contextWindow;
    const used = window ? Math.min(1, this.lastInput / window) : 0;
    const bar = window ? `${"█".repeat(Math.round(used * 30))}${s.dim("░".repeat(30 - Math.round(used * 30)))}` : "";
    const mins = Math.floor((Date.now() - this.startedAt) / 60_000);
    return {
      status: [
        ["Model", `${this.modelLabel}${this.opts.pickModel ? " · chosen by teh" : ""}`],
        ["Folder", this.agent.cwd],
        ["Session", `${this.session.id.slice(0, 13)} · ${this.countPrompts()} prompt(s) · continue with teh -c`],
        ["Permission mode", this.permissions.mode],
        ...(this.opts.statusInfo ?? []),
      ],
      config: this.configItems(),
      usage: [
        `${s.bold("Context")}   ${fmt(this.lastInput)}${window ? ` of ${fmt(window)} tokens (${Math.round(used * 100)}%)` : " tokens"}`,
        ...(bar ? [`          ${bar}`] : []),
        "",
        `${s.bold("Tokens")}    ${fmt(u.input)} in (${fmt(u.cachedRead)} from cache) · ${fmt(u.output)} out`,
        `${s.bold("Session")}   ${this.countPrompts()} prompt(s) · open ${mins} min`,
      ],
      help: [
        s.bold("Keys"),
        "Enter send · Shift+Enter, Alt+Enter or \\ then Enter: new line · ↑/↓ history",
        "Esc interrupt · Shift+Tab permission mode · Ctrl+C clear, twice to quit · Ctrl+D quit",
        "Typing while teh works queues your message for when it finishes.",
        ...(this.fullscreen
          ? ["Scroll: wheel, PgUp/PgDn, Shift+↑/↓, Ctrl+Home/End · select text with Shift (Option on macOS)"]
          : []),
        s.bold("Commands"),
        ...BUILTIN_COMMANDS.map(([n, d]) => `/${n.padEnd(10)} ${d}`),
        ...(this.agent.skills ?? [])
          .filter((k) => k.userInvocable)
          .map((k) => `/${k.name.padEnd(10)} ${s.dim(k.description.replace(/\s+/g, " ").slice(0, 70))}`),
      ],
    };
  }

  // --- Side questions -----------------------------------------------------------------

  // /btw: one question answered from the conversation so far, with no tools. Neither the
  // question nor the answer joins the conversation, so the main task's context is untouched.
  private async btw(question: string) {
    const s = this.style;
    if (!question.trim()) {
      this.note = "usage: /btw <question>";
      return this.render();
    }
    this.side++;
    this.render();
    const { provider, model } = this.agent;
    let answer = "";
    let failed: string | undefined;
    try {
      const items: Item[] = [...this.history, { kind: "text", role: "user", text: question }];
      for await (const ev of provider.stream({ model, system: BTW_SYSTEM, items, tools: [] })) {
        if (ev.type === "text_delta") answer += ev.text;
        else if (ev.type === "usage") this.usage = addUsage(this.usage, ev.usage);
      }
    } catch (e) {
      failed = (e as Error).message;
    }
    this.side--;
    this.flushText();
    const body = failed
      ? [s.red(`  │ ✗ ${failed}`)]
      : (answer.trim() || "(no answer)").split("\n").map((l) => `  ${s.magenta("│")} ${inlineMarkdown(l, s)}`);
    this.print([
      "",
      `  ${s.magenta("╭ btw")} ${s.italic(question)}`,
      ...body,
      `  ${s.magenta("╰")} ${s.dim("side answer · not added to the conversation")}`,
      "",
    ]);
    this.block = "none";
    this.textStarted = false;
    this.render();
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
    const skills: [string, string][] = (this.agent.skills ?? [])
      .filter((s) => s.userInvocable)
      .map((s) => [s.name, s.description]);
    return [...BUILTIN_COMMANDS, ...skills].filter(([n]) => n.toLowerCase().startsWith(q)).slice(0, 6);
  }

  // --- Prompts -----------------------------------------------------------------------

  private submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return this.render();
    const slash = parseSlash(trimmed);
    // The panel and side questions work while teh is busy; everything else waits its turn.
    if (slash && this.aside(slash.name, slash.args)) return;
    if (this.running) {
      this.queue.push(trimmed);
      return this.render();
    }
    if (slash && this.builtin(slash.name, slash.args)) return;
    let prompt = trimmed;
    if (slash) {
      const skill = (this.agent.skills ?? []).find((s: Skill) => s.name === slash.name && s.userInvocable);
      if (!skill) {
        const near = similarNames(slash.name, this.agent.skills ?? []);
        this.print([
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

  // Commands that never wait for the agent: the settings panel and /btw.
  private aside(name: string, args: string): boolean {
    const tab: Record<string, PanelTab> = {
      help: "Help",
      status: "Status",
      config: "Config",
      settings: "Config",
      usage: "Usage",
      cost: "Usage",
    };
    if (tab[name]) {
      this.openPanel(tab[name]);
      return true;
    }
    if (name === "btw") {
      void this.btw(args);
      return true;
    }
    return false;
  }

  // Built-in slash commands. Returns false when the name is not one.
  private builtin(name: string, _args: string): boolean {
    const s = this.style;
    switch (name) {
      case "exit":
      case "quit":
        this.quit(0);
        return true;
      case "clear":
        this.history = [];
        this.session = this.opts.newSession();
        this.hooks = this.opts.hooksFor?.(this.session);
        this.sessionStart = "clear";
        this.picked = false;
        this.renderer.reset?.();
        this.shownLines = [];
        this.usage = emptyUsage();
        this.lastInput = 0;
        this.print(["", s.dim("  (new conversation)"), ""]);
        this.render();
        return true;
      case "mode":
        this.cycleMode();
        return true;
      default:
        return false;
    }
  }

  private async runPrompt(shown: string, prompt: string, slash: { name: string; args: string } | undefined) {
    const s = this.style;
    this.print(["", ...shown.split("\n").map((l, i) => `${i === 0 ? s.bold(s.cyan("›")) : " "} ${s.bold(l)}`), ""]);
    const abort = new AbortController();
    this.running = { abort, started: Date.now(), prompt };
    this.textStarted = false;
    this.block = "none";
    this.startSpinner();
    this.render();
    const run = this.opts.run ?? runAgent;
    try {
      await this.chooseModel(prompt);
      const res = await run({
        ...this.agent,
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
      if (res.stopReason === "max_turns") this.print([s.yellow(`  stopped after ${res.turns} turns`)]);
      if (res.stopReason === "hook_blocked" || res.stopReason === "hook_stopped") this.history = this.reload();
    } catch (e) {
      this.flushText();
      this.history = this.reload();
      if (abort.signal.aborted) this.print([s.red("  ⎿ Interrupted") + s.dim(" · tell teh what to do instead")]);
      else if (e instanceof ProviderError)
        this.print([s.red(`  ✗ ${e.message}`), ...(e.hint ? [s.dim(`    fix: ${e.hint}`)] : [])]);
      else this.print([s.red(`  ✗ ${(e as Error).message}`)]);
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

  // With no pinned model, the first prompt of a session decides which model runs it.
  private async chooseModel(prompt: string) {
    if (!this.opts.pickModel || this.picked || this.history.length) return;
    this.picked = true;
    const pick = await this.opts.pickModel(prompt, this.permissions.mode === "plan");
    this.agent = { ...this.agent, provider: pick.provider, model: pick.model };
    this.modelLabel = pick.label;
    this.contextWindow = pick.contextWindow ?? this.contextWindow;
    this.modelReason = pick.reason;
    this.print([
      this.style.dim(`  model: ${pick.label} · chosen for this task (${pick.reason}) · --model pins one`),
      "",
    ]);
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
        this.callArgs.set(e.id, e.args);
        // A blank line sets each tool call apart from the reply text and from other calls.
        this.print([
          ...(this.block === "none" ? [] : [""]),
          e.summary ? toolHeader(e.summary, s) : toolHeaderFromCall(e.name, e.args, s),
        ]);
        this.block = "tool";
        this.textStarted = false;
        break;
      case "subagent":
        if (e.phase === "tool") this.explore = { model: e.model, last: e.summary, uses: (this.explore?.uses ?? 0) + 1 };
        else {
          this.explore = undefined;
          this.usage = addUsage(this.usage, e.usage);
        }
        break;
      case "tool_result":
        this.explore = undefined;
        this.print(resultLines(e.name, this.callArgs.get(e.id), e.content, e.isError, s));
        this.callArgs.delete(e.id);
        break;
      case "approval":
        if (e.behavior === "deny" && !e.reason.startsWith("approved")) {
          // Asked-and-refused shows in the approval prompt already.
          if (!e.reason.endsWith("needs approval")) this.print([s.red(`  ✗ ${e.reason}`)]);
        }
        break;
      case "hook":
        this.print([s.yellow(`  ${e.event} hook: ${e.message}`)]);
        break;
      case "warning":
        this.print([s.yellow(`  ! ${e.message}`)]);
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
    this.print(this.textLines(done));
  }

  private flushText() {
    if (this.partial) this.print(this.textLines(this.partial));
    this.partial = "";
  }

  private textLines(text: string): string[] {
    const s = this.style;
    let fence = false;
    return text.split("\n").flatMap((line) => {
      let out: string;
      if (/^\s*```/.test(line)) {
        fence = !fence;
        out = s.gray(line);
      } else if (fence) out = s.cyan(line);
      else out = inlineMarkdown(line, s);
      if (!line.trim() && !this.textStarted) return [];
      const first = !this.textStarted;
      const gap = first && this.block === "tool" ? [""] : [];
      this.textStarted = true;
      this.block = "text";
      return [...gap, (first ? `${s.bold("●")} ` : "  ") + out];
    });
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
      if (this.explore) {
        const x = this.explore;
        lines.push(
          s.dim(`  ⎿  ${x.model} · ${x.uses} tool use${x.uses === 1 ? "" : "s"} · ${x.last}`.slice(0, cols - 2)),
        );
      }
      if (this.side) lines.push(s.magenta("  ※ answering your side question…"));
      for (const q of this.queue) lines.push(s.dim(`  queued: ${q.replace(/\s+/g, " ").slice(0, cols - 14)}`));
      if (this.panel) {
        lines.push(...renderPanel(this.panel.tab, this.panel.selected, this.panelContent(), s, cols));
        this.renderer.setLive(lines);
        return;
      }
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
    const right = s.dim(`${this.modelLabel}${ctx}`);
    const left = `  ${modeText}`;
    const gap = Math.max(2, cols - 1 - visible(left) - visible(right));
    return left + " ".repeat(gap) + right;
  }

  private banner(): string[] {
    const s = this.style;
    return [
      `${s.bold("teh")} ${s.dim("· The Everything Harness")}`,
      s.dim(`  ${this.modelLabel} · ${this.agent.cwd}`),
      s.dim("  /help for keys and commands · Esc interrupts · Ctrl+D quits"),
      "",
    ];
  }

  // Print lines into the transcript, and keep them in the session's cache.
  private print(lines: string[]) {
    this.commit(lines);
    this.opts.transcript?.append(this.session.id, lines);
  }

  private commit(lines: string[]) {
    this.shownLines.push(...lines);
    if (this.shownLines.length > 20_000) this.shownLines.splice(0, this.shownLines.length - 20_000);
    this.renderer.commit(lines);
  }

  private makeRenderer(full: boolean): Screen {
    return full
      ? new FullscreenRenderer(this.opts.terminal, {
          header: (cols) => this.header(cols),
          dim: this.style.dim,
          mouse: true,
        })
      : new InlineRenderer(this.opts.terminal);
  }

  // Switch between full screen and inline without losing the conversation on screen.
  private setScreen(full: boolean) {
    if (full === this.fullscreen) return;
    const old = this.renderer;
    old.setLive([]);
    old.flush();
    old.leave?.();
    this.fullscreen = full;
    this.renderer = this.makeRenderer(full);
    this.renderer.enter?.();
    this.renderer.commit(this.shownLines);
  }

  // A resumed session: its cached transcript as it was shown, or, once the cache has
  // expired, a plainer one rebuilt from the conversation.
  private showEarlier() {
    const s = this.style;
    const cached = this.opts.transcript?.load(this.session.id);
    if (cached?.length) {
      this.commit([s.dim("  ── earlier in this session ──"), ...cached, s.dim("  ── resumed ──"), ""]);
      return;
    }
    const days = this.cacheDays;
    this.print([
      s.dim(
        `  ── earlier in this session (rebuilt from the conversation${this.opts.transcript ? `; the detailed view is kept ${days} day(s)` : ""}) ──`,
      ),
      ...rebuildTranscript(this.history, s),
      s.dim("  ── resumed ──"),
      "",
    ]);
  }

  private header(cols: number): string {
    const s = this.style;
    const left = `${s.bold("teh")} ${s.dim(`· ${this.modelLabel}`)}`;
    const right = s.dim(this.agent.cwd);
    const gap = cols - 1 - visible(left) - visible(right);
    return gap >= 2 ? left + " ".repeat(gap) + right : left;
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

// A transcript made from the conversation alone: prompts, replies, tool calls and the first
// line of each result. Used when a session's cached view has expired.
export function rebuildTranscript(items: Item[], s: Style): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.kind === "text" && item.role === "user") {
      if (/^\w+ hook: /.test(item.text)) continue;
      out.push("", ...item.text.split("\n").map((l, i) => `${i === 0 ? s.bold(s.cyan("›")) : " "} ${s.bold(l)}`), "");
    } else if (item.kind === "text") {
      out.push(...item.text.split("\n").map((l, i) => `${i === 0 ? s.bold("●") : " "} ${inlineMarkdown(l, s)}`));
    } else if (item.kind === "tool_call") {
      out.push("", toolHeaderFromCall(item.name, item.args, s));
    } else if (item.kind === "tool_result") {
      const head = (item.content.split("\n").find((l) => l.trim()) ?? "").slice(0, 160);
      out.push(`  ${item.isError ? s.red(`⎿  ${head}`) : s.dim(`⎿  ${head}`)}`);
    }
  }
  return out;
}

export async function runTui(opts: TuiOptions): Promise<number> {
  return new TuiApp(opts).start();
}
