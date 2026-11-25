// The interactive terminal UI (ADR-0005): a prompt at the bottom, the conversation printed
// into normal scrollback above it. Runs the same engine as `teh -p`, one runAgent per prompt,
// with the conversation carried over.
import {
  type Access,
  type AgentEvent,
  type AgentOptions,
  type AgentResult,
  AUTO_COMPACT_FRACTION,
  addUsage,
  capabilities,
  costUsd,
  describeShell,
  emptyUsage,
  expandMentions,
  expandSkill,
  formatUsd,
  type HookRunner,
  type Item,
  latestTodos,
  loadSession,
  type PermissionConfig,
  type PermissionMode,
  type PlanDecision,
  type Provider,
  ProviderError,
  parseRules,
  parseSlash,
  parseTodos,
  type RewindPoint,
  type RewindScope,
  ROUTE_LABEL,
  type RouteResult,
  rankFiles,
  routeOf,
  runAgent,
  runCompaction,
  type SessionLog,
  type SessionSummary,
  ShellRegistry,
  type Skill,
  similarNames,
  suggestRule,
  type Todo,
  USAGE_URL,
  type Usage,
} from "@everything-harness/core";
import { Editor } from "./editor";
import { FullscreenRenderer } from "./fullscreen";
import { type Key, KeyParser } from "./keys";
import { type ConfigItem, PANEL_TABS, type PanelContent, type PanelTab, renderPanel } from "./panel";
import { InlineRenderer, type Screen } from "./renderer";
import { BRACKETED_PASTE_OFF, BRACKETED_PASTE_ON, HIDE_CURSOR, SHOW_CURSOR, type TerminalIo } from "./terminal";
import { clip, makeStyle, type Style, wrap } from "./text";
import { resultLines, todoLines, toolHeader, toolHeaderFromCall } from "./toolview";

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
  // Called after each prompt's run, for the cost ledger and trace export.
  onRunEnd?: (r: { usage: Usage; provider: AgentOptions["provider"]; model: string; session: string }) => void;
  // Earlier prompts in this project, for Up and Ctrl+R; `add` keeps a new one.
  promptHistory?: { entries: string[]; add(text: string): void };
  // Paths in the project for @ completion.
  listFiles?: () => string[];
  // `!command`: runs a command in the user's shell; its output goes into the next prompt.
  runShell?: (command: string, signal: AbortSignal) => Promise<{ output: string; code: number | null }>;
  // Ctrl+G: edit the prompt in $VISUAL or $EDITOR. Called while the terminal is handed over.
  editExternal?: (text: string) => string | undefined;
  // Ctrl+V: save the clipboard's image to a file and return its path.
  pasteImage?: () => Promise<string | undefined>;
  // /resume: this project's sessions, and opening one.
  sessions?: {
    list(): SessionSummary[];
    open(id: string): { session: SessionLog; items: Item[] } | undefined;
  };
  // /rewind: the session's points, and going back to one (ADR-0004).
  rewind?: {
    points(session: SessionLog): RewindPoint[];
    apply(session: SessionLog, point: RewindPoint, scope: RewindScope): Promise<{ items: Item[]; lines: string[] }>;
  };
  // MCP prompts, run as /mcp__<server>__<prompt> (ADR-0025).
  mcpPrompts?: { name: string; description: string; expand(args: string): Promise<string> }[];
  // Chooses skills for a prompt (ADR-0015), as `teh -p` does.
  routeSkills?: (prompt: string) => Promise<RouteResult | undefined>;
  // Whether the terminal shows OSC 8 links and accepts OSC 52 copies.
  hyperlinks?: boolean;
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
  autoCompact?: boolean | undefined;
};

export type ModelPick = {
  provider: AgentOptions["provider"];
  model: string;
  label: string;
  contextWindow?: number;
  // Whether it accepts images.
  vision?: boolean;
  // Why this model, e.g. "S: short question".
  reason: string;
};

// A list to choose from: sessions for /resume, points for /rewind.
type Picker = {
  title: string;
  hint?: string;
  items: { label: string; detail?: string }[];
  selected: number;
  pick: (i: number) => void;
  cancel?: () => void;
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
  ["compact", "Summarise the conversation to free context; add text to steer the summary"],
  ["btw", "Ask a side question; it is not added to the conversation"],
  ["resume", "Pick an earlier conversation in this project to continue"],
  ["rewind", "Go back to an earlier point: code, conversation or both"],
  ["copy", "Copy the last reply to the clipboard"],
  ["todos", "Show the model's current to-do list"],
  ["shells", "List background shells; /shells kill <id|all> stops them"],
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
  private readonly editor: Editor;
  private history: Item[];
  private session: SessionLog;
  private readonly permissions: PermissionConfig;
  private running: { abort: AbortController; started: number; prompt: string } | undefined;
  private approval: Approval | undefined;
  private queue: string[] = [];
  private partial = ""; // streaming assistant text not yet committed
  private textStarted = false;
  private usage: Usage = emptyUsage();
  private cost: number | undefined = 0; // dollars, undefined once a price was unknown
  private lastInput = 0; // input tokens of the latest turn: the context in use
  private note = ""; // one-line message under the prompt, cleared on the next key
  private exitArmed = false;
  private sessionStart: "startup" | "resume" | "clear" | "compact" | undefined;
  private compacting = false;
  private todos: Todo[] | undefined; // the model's latest to-do list
  private planReview: ((d: PlanDecision) => void) | undefined; // waiting for a plan approval
  private readonly shells = new ShellRegistry();
  private tokenScale = 1; // reported tokens per estimated token, carried between prompts
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
  private picker: Picker | undefined;
  private shellContext: string[] = [];
  private notes: string[] = []; // lines printed under the next prompt (attachments, warnings) // `!` commands and their output, sent with the next prompt
  private shellRunning: AbortController | undefined;
  private files: string[] | undefined; // for @ completion, listed on first use
  private readonly callArgs = new Map<string, unknown>();
  private block: "none" | "text" | "tool" = "none"; // what was printed last in this reply
  private cacheDays: number;
  private side = 0; // /btw questions still being answered
  private explore: { model: string; last: string; uses: number } | undefined; // a running subagent
  private readonly startedAt = Date.now();

  constructor(private readonly opts: TuiOptions) {
    this.style = makeStyle(opts.color, opts.hyperlinks ?? false);
    this.editor = new Editor(opts.promptHistory?.entries ?? []);
    this.fullscreen = opts.fullscreen ?? false;
    this.renderer = this.makeRenderer(this.fullscreen);
    this.saved = structuredClone(opts.settings ?? {});
    this.agent = { ...opts.agent };
    this.modelLabel = opts.modelLabel;
    this.contextWindow = opts.contextWindow;
    this.history = opts.history ?? [];
    this.todos = latestTodos(this.history);
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
    this.cleanups.push(this.shells.onChange(() => this.render()));
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
    this.planReview?.({ approved: false });
    this.shells.killAll();
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
    if (this.planReview) return this.onPlanKey(k);
    if (this.panel) return this.onPanelKey(k);
    if (this.picker) return this.onPickerKey(k);
    if (this.editor.search) {
      this.editor.handle(k);
      return this.render();
    }
    if (k.kind === "ctrlC") {
      if (this.shellRunning) return this.shellRunning.abort();
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
      if (this.shellRunning) return this.shellRunning.abort();
      if (this.running) return this.interrupt();
      return;
    }
    if (k.kind === "ctrlG") return this.editInEditor();
    if (k.kind === "ctrlV") return void this.pasteImage();
    if (k.kind === "ctrlD" && !this.editor.text) return this.quit(0);
    if (k.kind === "shiftTab") return this.cycleMode();
    if (k.kind === "ctrlL") return this.renderer.redraw();
    if (k.kind === "tab") {
      const at = this.mentionAtCursor();
      if (at) {
        const first = this.fileCompletions(at.query)[0];
        if (first) {
          const t = this.editor.text;
          const quoted = /\s/.test(first) ? `"${first}"` : first;
          const tail = first.endsWith("/") ? "" : " ";
          this.editor.text = `${t.slice(0, at.start)}@${quoted}${tail}${t.slice(this.editor.cursor)}`;
          this.editor.cursor = at.start + 1 + quoted.length + tail.length;
        }
        return this.render();
      }
      const first = this.completions()[0];
      if (first) this.editor.set(`/${first[0]} `);
      return this.render();
    }
    this.note = "";
    const r = this.editor.handle(k);
    if (r?.submit !== undefined) this.submit(r.submit);
    else this.render();
  }

  private onPickerKey(k: Key) {
    const p = this.picker as Picker;
    if (k.kind === "up") p.selected = Math.max(0, p.selected - 1);
    else if (k.kind === "down") p.selected = Math.min(p.items.length - 1, p.selected + 1);
    else if (k.kind === "home") p.selected = 0;
    else if (k.kind === "end") p.selected = p.items.length - 1;
    else if (k.kind === "enter") {
      this.picker = undefined;
      p.pick(p.selected);
      return this.render();
    } else if (k.kind === "escape" || k.kind === "ctrlC") {
      this.picker = undefined;
      p.cancel?.();
    } else if (k.kind === "char" && /^[1-9]$/.test(k.text) && Number(k.text) <= p.items.length) {
      this.picker = undefined;
      p.pick(Number(k.text) - 1);
      return this.render();
    }
    this.render();
  }

  private renderPicker(p: Picker, cols: number): string[] {
    const s = this.style;
    const rows = Math.max(3, Math.min(12, this.opts.terminal.rows() - 8));
    const start = Math.max(0, Math.min(p.selected - Math.floor(rows / 2), p.items.length - rows));
    const out = [s.gray("─".repeat(Math.max(10, cols - 1))), ` ${s.bold(p.title)}`];
    for (let i = start; i < Math.min(p.items.length, start + rows); i++) {
      const it = p.items[i] as Picker["items"][number];
      const mark = i === p.selected ? s.cyan("❯") : " ";
      const num = i < 9 ? s.dim(`${i + 1}.`) : "  ";
      const label = i === p.selected ? s.bold(it.label) : it.label;
      const room = Math.max(10, cols - 8);
      const text = it.detail ? `${label}  ${s.dim(it.detail)}` : label;
      out.push(` ${mark} ${num} ${clip(text, room)}`);
    }
    if (p.items.length > rows) out.push(s.dim(`   ${p.selected + 1} of ${p.items.length}`));
    out.push(s.dim(`   ${p.hint ?? "↑↓ choose · enter select · esc cancel"}`));
    return out;
  }

  // The "@query" being typed at the cursor, if any.
  private mentionAtCursor(): { start: number; query: string } | undefined {
    const before = this.editor.text.slice(0, this.editor.cursor);
    const m = before.match(/(^|\s)@("?)([^\s"]*)$/);
    if (!m || !this.opts.listFiles) return undefined;
    return { start: before.length - (m[2] as string).length - (m[3] as string).length - 1, query: m[3] as string };
  }

  private fileCompletions(query: string): string[] {
    this.files ??= this.opts.listFiles?.() ?? [];
    return rankFiles(this.files, query, 6);
  }

  // Ctrl+G: hand the terminal to the person's editor, then take the text back.
  private editInEditor() {
    const edit = this.opts.editExternal;
    if (!edit) {
      this.note = "set $EDITOR to edit prompts in your editor";
      return this.render();
    }
    const t = this.opts.terminal;
    this.renderer.setLive([]);
    this.renderer.flush();
    this.renderer.leave?.();
    t.write(BRACKETED_PASTE_OFF + SHOW_CURSOR);
    t.setRawMode(false);
    let text: string | undefined;
    try {
      text = edit(this.editor.text);
    } finally {
      t.setRawMode(true);
      t.write(BRACKETED_PASTE_ON + HIDE_CURSOR);
      if (this.renderer.enter) this.renderer.enter();
      else this.renderer.redraw();
    }
    if (text !== undefined) this.editor.set(text.replace(/\n+$/, ""));
    else this.note = "the editor exited without saving; the prompt is unchanged";
    this.render();
  }

  // Ctrl+V: an image on the clipboard becomes an @-mention of a saved copy.
  private async pasteImage() {
    const path = await this.opts.pasteImage?.().catch(() => undefined);
    if (!path) {
      this.note = "no image on the clipboard (text pastes as usual)";
      return this.render();
    }
    const quoted = /\s/.test(path) ? `@"${path}" ` : `@${path} `;
    const before = this.editor.text.slice(0, this.editor.cursor);
    this.editor.insert(before && !/\s$/.test(before) ? ` ${quoted}` : quoted);
    this.render();
  }

  // `!command`: run it in the person's shell, show the output, and send both with the next prompt.
  private async shellCommand(command: string) {
    const s = this.style;
    this.editor.remember(`!${command}`);
    this.opts.promptHistory?.add(`!${command}`);
    this.flushText();
    this.print(["", `${s.bold(s.magenta("!"))} ${s.bold(command)}`]);
    if (!this.opts.runShell) {
      this.print([s.red("  ✗ shell commands are not available here"), ""]);
      return this.render();
    }
    const abort = new AbortController();
    this.shellRunning = abort;
    this.render();
    let output = "";
    let code: number | null = null;
    try {
      ({ output, code } = await this.opts.runShell(command, abort.signal));
    } catch (e) {
      output = (e as Error).message;
    } finally {
      this.shellRunning = undefined;
    }
    const lines = output.replace(/\n$/, "").split("\n");
    const shown = lines.length > 30 ? [...lines.slice(0, 30), `… ${lines.length - 30} more lines`] : lines;
    this.print([
      ...shown.map((l, i) => `  ${s.dim(i === 0 ? "⎿ " : "  ")} ${l}`),
      ...(code ? [s.red(`  exit code ${code}`)] : []),
      ...(abort.signal.aborted ? [s.red("  ⎿ Interrupted")] : []),
      s.dim("  (sent with your next message)"),
      "",
    ]);
    const kept = output.length > 30_000 ? `${output.slice(0, 30_000)}\n… (cut at 30,000 characters)` : output;
    this.shellContext.push(
      `<bash-input>${command}</bash-input>\n<bash-output exit_code="${code ?? "killed"}">${kept}</bash-output>`,
    );
    this.render();
  }

  private openResume() {
    const list = this.opts.sessions?.list().filter((x) => x.id !== this.session.id) ?? [];
    if (!this.opts.sessions || !list.length) {
      this.note = this.opts.sessions ? "no other conversations in this project yet" : "resume is not available here";
      return this.render();
    }
    this.picker = {
      title: "Resume a conversation",
      items: list.map((x) => ({
        label: oneLine(x.firstPrompt || "(no prompt)"),
        detail: `${ago(x.updated)} · ${x.prompts} prompt${x.prompts === 1 ? "" : "s"}${x.model ? ` · ${x.model}` : ""}`,
      })),
      selected: 0,
      pick: (i) => this.resumeSession((list[i] as SessionSummary).id),
    };
    this.render();
  }

  private resumeSession(id: string) {
    const s = this.style;
    const opened = this.opts.sessions?.open(id);
    if (!opened) {
      this.note = "could not read that session";
      return;
    }
    this.session = opened.session;
    this.history = opened.items;
    this.todos = latestTodos(this.history);
    this.hooks = this.opts.hooksFor?.(this.session);
    this.sessionStart = "resume";
    this.picked = true;
    this.usage = emptyUsage();
    this.cost = 0;
    this.lastInput = 0;
    this.shellContext = [];
    this.renderer.reset?.();
    this.shownLines = [];
    this.commit(this.banner());
    this.showEarlier();
    this.print([s.dim(`  (resumed ${id.slice(0, 13)})`), ""]);
  }

  private openRewind() {
    const r = this.opts.rewind;
    const points = r?.points(this.session) ?? [];
    if (!r || !points.length) {
      this.note = r ? "nothing to rewind to yet in this conversation" : "rewind is not available here";
      return this.render();
    }
    // Newest first, as in Claude Code.
    const shown = [...points].reverse();
    this.picker = {
      title: "Rewind to before…",
      items: shown.map((p) => ({
        label:
          p.kind === "prompt"
            ? `Prompt ${p.prompt}: ${oneLine(p.promptText)}`
            : p.kind === "rewind"
              ? p.title
              : `  ${p.title}`,
        detail: `${clock(p.time)}${p.rewound ? " · rewound" : ""}`,
      })),
      selected: 0,
      pick: (i) => this.chooseScope(shown[i] as RewindPoint),
    };
    this.render();
  }

  private chooseScope(point: RewindPoint) {
    const scopes: [RewindScope, string][] = [
      ["both", "Code and conversation"],
      ["conversation", "Conversation only (files stay as they are)"],
      ["code", "Code only (the conversation stays as it is)"],
    ];
    this.picker = {
      title: `Rewind to ${point.kind === "prompt" ? `prompt ${point.prompt}` : point.title}: what goes back?`,
      items: scopes.map(([, label]) => ({ label })),
      selected: 0,
      pick: (i) => void this.applyRewind(point, (scopes[i] as [RewindScope, string])[0]),
    };
  }

  private async applyRewind(point: RewindPoint, scope: RewindScope) {
    const s = this.style;
    try {
      const r = await (this.opts.rewind as NonNullable<TuiOptions["rewind"]>).apply(this.session, point, scope);
      if (scope !== "code") {
        this.history = r.items;
        this.todos = latestTodos(this.history);
      }
      this.flushText();
      this.print(["", ...r.lines.map((l) => s.dim(`  ${l}`)), ""]);
      // Going back to a prompt puts it back in the editor, ready to change and resend.
      if (scope !== "code" && point.kind === "prompt" && !this.editor.text) this.editor.set(point.promptText);
    } catch (e) {
      this.print([s.red(`  ✗ ${(e as Error).message}`), ""]);
    }
    this.render();
  }

  // /copy: the last reply, through the terminal (OSC 52), so it works over SSH too.
  private copyLastReply() {
    const last = [...this.history].reverse().find((i) => i.kind === "text" && i.role === "assistant");
    if (last?.kind !== "text") {
      this.note = "no reply to copy yet";
      return this.render();
    }
    this.opts.terminal.write(`\x1b]52;c;${Buffer.from(last.text, "utf8").toString("base64")}\x07`);
    this.note = `copied ${last.text.length} characters (if your terminal allows clipboard access)`;
    this.render();
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

  // ExitPlanMode (ADR-0022): the plan goes into the transcript, and the answer sets the mode.
  private reviewPlan(plan: string): Promise<PlanDecision> {
    const s = this.style;
    this.flushText();
    this.print([
      "",
      s.cyan("╭ Plan"),
      ...plan
        .trim()
        .split("\n")
        .map((l) => `${s.cyan("│")} ${inlineMarkdown(l, s)}`),
      s.cyan("╰"),
    ]);
    this.block = "none";
    this.opts.onNotify?.("teh has a plan for you to approve");
    this.opts.terminal.write("\x07");
    return new Promise((resolve) => {
      this.planReview = resolve;
      this.render();
    });
  }

  private onPlanKey(k: Key) {
    const resolve = this.planReview;
    if (!resolve) return;
    const done = (d: PlanDecision) => {
      this.planReview = undefined;
      this.print([
        d.approved
          ? `  ${this.style.green(`✓ plan approved · ${d.mode === "acceptEdits" ? "edits are accepted" : "each change asks first"}`)}`
          : `  ${this.style.yellow("✗ keep planning")}${this.style.dim(" · Esc and type to tell teh what to change")}`,
      ]);
      resolve(d);
      this.render();
    };
    if (k.kind === "char") {
      const c = k.text.toLowerCase();
      if (c === "a" || c === "1") return done({ approved: true, mode: "acceptEdits" });
      if (c === "y" || c === "2") return done({ approved: true, mode: "default" });
      if (c === "n" || c === "3") return done({ approved: false });
    }
    if (k.kind === "escape" || k.kind === "ctrlC") return done({ approved: false });
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
      {
        label: "Auto-compact",
        value: this.agent.autoCompact === false ? "off" : "on",
        hint: this.contextWindow
          ? `summarises older turns at ${Math.round(AUTO_COMPACT_FRACTION * 100)}% of ${fmt(this.contextWindow)} tokens`
          : "context window unknown; /compact still works",
        change: () => {
          const on = this.agent.autoCompact === false;
          this.agent = { ...this.agent, autoCompact: on };
          set("user", "autoCompact", on ? undefined : false);
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
      this.agent = { ...this.agent, provider: pick.provider, model: pick.model, vision: pick.vision ?? false };
      this.modelLabel = pick.label;
      this.contextWindow = pick.contextWindow ?? this.contextWindow;
      this.modelReason = "";
      this.picked = true;
      this.tokenScale = 1;
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
        ["Paid by", ROUTE_LABEL[this.agent.provider.route]],
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
        `${s.bold("Cost")}      ${this.costLine()}`,
        `${s.bold("Session")}   ${this.countPrompts()} prompt(s) · open ${mins} min`,
      ],
      help: [
        s.bold("Keys"),
        "Enter send · Shift+Enter, Alt+Enter or \\ then Enter: new line · ↑/↓ history",
        "Esc interrupt · Shift+Tab permission mode · Ctrl+C clear, twice to quit · Ctrl+D quit",
        "@path attach a file or folder (Tab completes) · !command run in your shell",
        "Ctrl+R search earlier prompts · Ctrl+G edit in $EDITOR · Ctrl+V paste an image",
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
  // ADR-0009: the status line says who pays. The ChatGPT plan uses OpenAI's wording.
  private routeNote(): string {
    const route = this.agent.provider.route;
    return route === "chatgpt-plan" ? " · Using ChatGPT plan" : route === "api-key" ? " · API key" : "";
  }

  private costLine(): string {
    const route = this.agent.provider.route;
    if (route === "local") return "$0 (local model)";
    if (route === "chatgpt-plan") return `included in your ChatGPT plan · Manage usage: ${USAGE_URL}`;
    return this.cost === undefined
      ? "unknown (no price for this model)"
      : `${formatUsd(this.cost)} (API key, list prices)`;
  }

  // Adds a usage total to the session's cost, priced for the model that ran it (ADR-0002).
  private charge(u: Usage, provider = this.agent.provider, model = this.agent.model) {
    const c = costUsd(provider.route, capabilities(provider.id, model), u);
    this.cost = c === undefined || this.cost === undefined ? undefined : this.cost + c;
  }

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
        else if (ev.type === "usage") {
          this.usage = addUsage(this.usage, ev.usage);
          this.charge(ev.usage, provider, model);
        }
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
    const prompts: [string, string][] = (this.opts.mcpPrompts ?? []).map((p) => [p.name, p.description]);
    return [...BUILTIN_COMMANDS, ...skills, ...prompts].filter(([n]) => n.toLowerCase().startsWith(q)).slice(0, 6);
  }

  // --- Prompts -----------------------------------------------------------------------

  private submit(text: string) {
    const trimmed = text.trim();
    if (!trimmed) return this.render();
    if (!trimmed.startsWith("!")) this.opts.promptHistory?.add(trimmed);
    if (trimmed.startsWith("!") && !this.running) {
      const command = trimmed.slice(1).trim();
      if (command) void this.shellCommand(command);
      return this.render();
    }
    const slash = parseSlash(trimmed);
    // The panel and side questions work while teh is busy; everything else waits its turn.
    if (slash && this.aside(slash.name, slash.args)) return;
    if (this.running) {
      this.queue.push(trimmed);
      return this.render();
    }
    if (slash && this.builtin(slash.name, slash.args)) return;
    let prompt = trimmed;
    const mcpPrompt = slash ? this.opts.mcpPrompts?.find((p) => p.name === slash.name) : undefined;
    if (slash && mcpPrompt) {
      void mcpPrompt
        .expand(slash.args)
        .then((text) => this.runPrompt(trimmed, text, slash))
        .catch((e: Error) => {
          this.print([this.style.red(`  ✗ ${e.message}`), ""]);
          this.render();
        });
      return;
    }
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
    if (!slash) prompt = this.withAttachments(prompt);
    void this.runPrompt(trimmed, prompt, slash ?? undefined);
  }

  // @-mentions become attached files, and `!` command output goes in front.
  private withAttachments(prompt: string): string {
    const s = this.style;
    const { prompt: expanded, mentions } = expandMentions(prompt, {
      cwd: this.agent.cwd,
      permissions: this.permissions,
    });
    const problems = mentions.filter((m) => m.kind === "missing" || m.kind === "denied" || m.kind === "binary");
    if (problems.length)
      this.notes.push(
        ...problems.map((m) =>
          s.yellow(
            `  ⚠ ${m.token}: ${m.kind === "missing" ? "no such file" : m.kind === "binary" ? "not a text file" : (m.note ?? "denied")}; not attached`,
          ),
        ),
      );
    const attached = mentions.filter((m) => m.kind === "file" || m.kind === "dir" || m.kind === "image");
    if (attached.length) this.notes.push(s.dim(`  ⎿ attached ${attached.map((m) => m.path).join(", ")}`));
    if (!this.shellContext.length) return expanded;
    const context = this.shellContext.splice(0).join("\n");
    return `${context}\n\n${expanded}`;
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
    if (name === "copy") {
      this.copyLastReply();
      return true;
    }
    if (name === "shells") {
      const [verb, id] = args.trim().split(/\s+/);
      if (verb === "kill" && id) {
        if (id === "all") this.shells.killAll();
        else if (!this.shells.kill(id)) this.note = `no shell ${id}`;
      }
      const all = this.shells.list();
      this.flushText();
      this.print([
        "",
        `${this.style.cyan("◆")} ${this.style.bold("Background shells")}`,
        ...(all.length
          ? all.map((x, i) => `${i === 0 ? `  ${this.style.dim("⎿")}  ` : "     "}${describeShell(x)}`)
          : [this.style.dim("  None. The model starts one with Bash run_in_background.")]),
        "",
      ]);
      this.block = "none";
      this.render();
      return true;
    }
    if (name === "todos") {
      const list = this.todos?.length
        ? todoLines(this.todos, this.style)
        : [this.style.dim("  No to-do list yet: the model makes one for multi-step work.")];
      this.flushText();
      this.print(["", `${this.style.cyan("◆")} ${this.style.bold("Todos")}`, ...list, ""]);
      this.block = "none";
      this.render();
      return true;
    }
    return false;
  }

  // Built-in slash commands. Returns false when the name is not one.
  private builtin(name: string, args: string): boolean {
    const s = this.style;
    switch (name) {
      case "exit":
      case "quit":
        this.quit(0);
        return true;
      case "clear":
        this.history = [];
        this.todos = undefined;
        this.session = this.opts.newSession();
        this.hooks = this.opts.hooksFor?.(this.session);
        this.sessionStart = "clear";
        this.picked = false;
        this.renderer.reset?.();
        this.shownLines = [];
        this.usage = emptyUsage();
        this.cost = 0;
        this.lastInput = 0;
        this.tokenScale = 1;
        this.print(["", s.dim("  (new conversation)"), ""]);
        this.render();
        return true;
      case "mode":
        this.cycleMode();
        return true;
      case "resume":
        this.openResume();
        return true;
      case "rewind":
        this.openRewind();
        return true;
      case "compact":
        void this.compact(args.trim());
        return true;
      default:
        return false;
    }
  }

  // /compact: replace the conversation with a summary (ADR-0020). Unlike the automatic kind,
  // nothing is kept verbatim, as in Claude Code; the transcript on screen stays.
  private async compact(instructions: string) {
    const s = this.style;
    if (!this.history.length) {
      this.note = "nothing to compact yet";
      return this.render();
    }
    const abort = new AbortController();
    this.running = { abort, started: Date.now(), prompt: "/compact" };
    this.compacting = true;
    this.startSpinner();
    this.render();
    try {
      const r = await runCompaction({
        provider: this.agent.provider,
        model: this.agent.model,
        items: this.history,
        contextWindow: this.contextWindow ?? 32_768,
        keepTokens: 0,
        trigger: "manual",
        scale: this.tokenScale,
        session: this.session,
        signal: abort.signal,
        ...(instructions ? { instructions } : {}),
        ...(this.hooks ? { hooks: this.hooks } : {}),
        emit: (e) => this.onEvent(e),
      });
      this.history = r.items;
      // SessionStart hooks see "compact" on the next prompt, as in Claude Code.
      if (this.hooks) this.sessionStart = "compact";
    } catch (e) {
      if (abort.signal.aborted)
        this.print([s.red("  ⎿ Compaction interrupted") + s.dim(" · the conversation is unchanged")]);
      else this.print([s.red(`  ✗ could not compact: ${(e as Error).message}`)]);
    } finally {
      this.compacting = false;
      this.running = undefined;
      this.stopSpinner();
    }
    this.render();
    if (this.queue.length) this.submit(this.queue.splice(0).join("\n\n"));
  }

  private async runPrompt(shown: string, prompt: string, slash: { name: string; args: string } | undefined) {
    const s = this.style;
    this.print([
      "",
      ...shown.split("\n").map((l, i) => `${i === 0 ? s.bold(s.cyan("›")) : " "} ${s.bold(l)}`),
      ...this.notes.splice(0),
      "",
    ]);
    const abort = new AbortController();
    this.running = { abort, started: Date.now(), prompt };
    this.textStarted = false;
    this.block = "none";
    this.startSpinner();
    this.render();
    const run = this.opts.run ?? runAgent;
    try {
      await this.chooseModel(prompt);
      const skillRoute = slash ? undefined : await this.opts.routeSkills?.(shown).catch(() => undefined);
      if (skillRoute?.chosen.length)
        this.print([s.dim(`  ⎿ skill${skillRoute.chosen.length > 1 ? "s" : ""}: ${skillRoute.chosen.join(", ")}`)]);
      const res = await run({
        ...(skillRoute ? { skillRoute } : {}),
        ...this.agent,
        permissions: this.permissions,
        prompt,
        history: this.history,
        session: this.session,
        signal: abort.signal,
        ...(this.contextWindow ? { contextWindow: this.contextWindow, tokenScale: this.tokenScale } : {}),
        shells: this.shells,
        reviewPlan: (plan: string) => this.reviewPlan(plan),
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
      this.opts.onRunEnd?.({
        usage: res.usage,
        provider: this.agent.provider,
        model: this.agent.model,
        session: this.session.id,
      });
      this.history = res.items;
      this.tokenScale = res.tokenScale;
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
    this.agent = { ...this.agent, provider: pick.provider, model: pick.model, vision: pick.vision ?? false };
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
        if (e.name === "TodoWrite") {
          try {
            this.todos = parseTodos(e.args);
          } catch {
            // Invalid lists are refused by the tool; keep the last good one.
          }
        }
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
          const at = e.model.indexOf(":");
          if (at > 0) {
            const id = e.model.slice(0, at);
            this.charge(e.usage, { id, route: routeOf(id) } as Provider, e.model.slice(at + 1));
          }
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
      case "compact":
        if (e.phase === "start") {
          this.flushText();
          this.compacting = true;
        } else {
          this.compacting = false;
          this.usage = addUsage(this.usage, e.usage);
          this.charge(e.usage);
          this.lastInput = e.after;
          const why = e.trigger === "auto" ? "the context was nearly full" : "you asked";
          this.print([
            ...(this.block === "none" ? [] : [""]),
            s.dim(`✻ Conversation compacted (${why}): ~${fmt(e.before)} → ~${fmt(e.after)} tokens`),
            s.dim("  The model now sees a summary of what came before; the transcript above is unchanged."),
            "",
          ]);
          this.block = "none";
          this.textStarted = false;
        }
        break;
      case "turn_end":
        this.usage = addUsage(this.usage, e.usage);
        this.charge(e.usage);
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
    } else if (this.planReview) {
      lines.push(
        "",
        s.cyan("╭ Approve this plan and start?"),
        `│ ${s.bold("a")} yes, and accept edits   ${s.bold("y")} yes, ask before each change   ${s.bold("n")} keep planning ${s.dim("(esc)")}`,
        s.cyan("╰"),
      );
    } else {
      if (this.running) {
        const secs = Math.floor((Date.now() - this.running.started) / 1000);
        const spin = this.opts.animate === false ? "✻" : (SPINNER[this.frame % SPINNER.length] as string);
        const doing = this.todos?.find((t) => t.status === "in_progress");
        const what = this.compacting
          ? "Compacting the conversation…"
          : doing
            ? `${doing.activeForm ?? doing.content}…`
            : "Working…";
        lines.push(`${s.magenta(spin)} ${s.dim(`${what} (${secs}s · esc to interrupt)`)}`);
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
      if (this.picker) {
        lines.push(...this.renderPicker(this.picker, cols));
        this.renderer.setLive(lines);
        return;
      }
      if (this.shellRunning) lines.push(`${s.magenta("!")} ${s.dim("running… (esc to stop)")}`);
      lines.push(s.gray("─".repeat(Math.max(10, cols - 1))));
      lines.push(...this.editor.render(s, cols - 1, this.running ? "" : "Ask teh anything · /help for commands"));
      lines.push(s.gray("─".repeat(Math.max(10, cols - 1))));
      const completions = this.completions();
      const at = this.editor.search ? undefined : this.mentionAtCursor();
      const files = at ? this.fileCompletions(at.query) : [];
      if (this.editor.search) lines.push(s.dim("  ctrl+r older · enter use it · esc cancel"));
      else if (files.length) {
        for (const f of files) lines.push(`  ${s.cyan(`@${f}`)}`);
        lines.push(s.dim("  tab to complete"));
      } else if (this.editor.text.startsWith("!") && !this.running) {
        lines.push(s.magenta("  ! shell mode: runs in your shell; the output goes with your next message"));
      } else if (completions.length) {
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
    const window = this.contextWindow;
    const pct = window ? Math.round((this.lastInput / window) * 100) : 0;
    // Near the limit, say how close automatic compaction is (ADR-0020).
    const ctx = !this.lastInput
      ? ""
      : pct >= 50 && this.agent.autoCompact !== false
        ? ` · ${pct}% context, compacts at ${Math.round(AUTO_COMPACT_FRACTION * 100)}%`
        : ` · ${fmt(this.lastInput)} context`;
    const running = this.shells.running;
    const shells = running ? ` · ${running} shell${running === 1 ? "" : "s"} running` : "";
    const right = s.dim(`${this.modelLabel}${this.routeNote()}${ctx}${shells}`);
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
const oneLine = (t: string) => t.replace(/\s+/g, " ").trim();
const pad2 = (n: number) => String(n).padStart(2, "0");
const clock = (d: Date) => `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
function ago(d: Date): string {
  const m = Math.round((Date.now() - d.getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)}h ago`;
  return `${Math.round(m / 1440)}d ago`;
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

// **bold**, `code` and # headings; enough to read a reply, without a Markdown parser.
function inlineMarkdown(line: string, s: Style): string {
  const h = line.match(/^(#{1,6})\s+(.*)$/);
  if (h) return s.bold(h[2] as string);
  return line
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t: string, url: string) => s.link(s.blue(t), url))
    .replace(
      /(^|[\s(])(https?:\/\/[^\s)<>"'`]+[^\s)<>"'`.,;:!?])/g,
      (_, pre: string, url: string) => pre + s.link(url, url),
    )
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
