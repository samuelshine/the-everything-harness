import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, FakeProvider, type FakeTurn, type Provider, say, VERSION } from "@everything-harness/core";
import { VirtualTerminal } from "../../tui/test/vt";
import { type Deps, run, USAGE } from "../src/cli";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-cli-")));

type CallOpts = {
  turns?: FakeTurn[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  home?: string;
  confirm?: boolean;
  answers?: string[];
};

async function call(argv: string[], opts: CallOpts = {}) {
  let out = "";
  let err = "";
  const cwd = opts.cwd ?? temp();
  const home = opts.home ?? temp();
  const fake = new FakeProvider(opts.turns ?? []);
  const deps: Deps = { provider: () => fake as Provider };
  const code = await run(
    argv,
    {
      out: (s) => (out += s),
      err: (s) => (err += s),
      env: { TEH_HOME: home, HOME: home, ...opts.env },
      cwd,
      stdin: async () => opts.stdin,
      ...(opts.confirm === undefined ? {} : { confirm: async () => opts.confirm as boolean }),
      ...(opts.answers ? { ask: async () => opts.answers?.shift() } : {}),
    },
    deps,
  );
  return { code, out, err, cwd, home, fake };
}

describe("teh cli", () => {
  test("--version prints the core version", async () => {
    expect(await call(["--version"])).toMatchObject({ code: 0, out: `teh ${VERSION}\n` });
  });

  test("no arguments prints usage", async () => {
    expect(await call([])).toMatchObject({ code: 0, out: USAGE });
  });

  test("unknown option exits 2 with usage on stderr", async () => {
    const r = await call(["--nope"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("--nope");
  });

  test("a prompt without -p and without a terminal explains how to run headlessly", async () => {
    const r = await call(["hello"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("the interactive UI needs a terminal; use -p");
  });

  test("with a terminal, teh opens the interactive UI with MCP tools, sends the first prompt, and quits on Ctrl+D", async () => {
    const cwd = temp();
    const home = temp();
    const vt = new VirtualTerminal(80, 30);
    const fake = new FakeProvider([say("hi from the UI")]);
    const server = join(import.meta.dir, "../../core/test/fixtures/mcp-server.ts");
    const mcpConfig = JSON.stringify({ mcpServers: { local: { command: process.execPath, args: [server] } } });
    const running = run(
      ["--model", "fake:fake", "--mcp-config", mcpConfig, "say", "hi"],
      {
        out: () => {},
        err: () => {},
        env: { TEH_HOME: home, HOME: home, NO_COLOR: "1" },
        cwd,
        stdin: async () => undefined,
        terminal: () => vt,
      },
      { provider: () => fake as Provider },
    );
    // A folder teh has not been started in before: it asks first, and "n" opens it untrusted.
    for (let i = 0; i < 50 && !vt.text().includes("Esc quits"); i++) await Bun.sleep(20);
    expect(vt.text()).toContain("Do you trust the files in this folder?");
    expect(vt.text()).toContain(cwd);
    expect(fake.requests.length).toBe(0);
    vt.type("n");
    for (let i = 0; i < 50 && !vt.text().includes("hi from the UI"); i++) await Bun.sleep(20);
    expect(vt.text()).toContain("› say hi");
    expect(vt.text()).toContain("● hi from the UI");
    // MCP tools reach the model in the UI too.
    expect(fake.requests[0]?.tools.map((t) => t.name)).toContain("mcp__local__echo");
    vt.type("\x04");
    expect(await running).toBe(0);
    // The conversation was saved as a session that -c can continue.
    const sessions = await call(["sessions"], { cwd, home });
    expect(sessions.out).toContain("say hi");
  });

  test("the UI's session cache expires after 3 days, and --continue still carries the conversation", async () => {
    const cwd = temp();
    const home = temp();
    const ui = async (
      argv: string[],
      turns: FakeTurn[],
      keys: string,
      until: string,
      env: Record<string, string> = {},
    ) => {
      const vt = new VirtualTerminal(80, 30);
      const fake = new FakeProvider(turns);
      const running = run(
        ["--model", "fake:fake", ...argv],
        {
          out: () => {},
          err: () => {},
          env: { TEH_HOME: home, HOME: home, NO_COLOR: "1", ...env },
          cwd,
          stdin: async () => undefined,
          terminal: () => vt,
        },
        { provider: () => fake as Provider },
      );
      for (let i = 0; i < 50 && !/Esc quits|Ask teh anything/.test(vt.text()); i++) await Bun.sleep(20);
      const asked = vt.text().includes("Do you trust the files in this folder?");
      if (asked) vt.type("y");
      for (let i = 0; i < 50 && !vt.text().includes("Ask teh anything"); i++) await Bun.sleep(20);
      vt.type(keys);
      for (let i = 0; i < 50 && !vt.text().includes(until); i++) await Bun.sleep(20);
      const screen = vt.text();
      vt.type("\x04");
      expect(await running).toBe(0);
      return { screen, fake, asked };
    };
    const first = await ui([], [say("the answer is 42")], "remember 42\r", "the answer is 42");
    // Trust is asked once per folder: "y" is remembered.
    expect(first.asked).toBe(true);
    expect((await call(["permissions"], { cwd, home })).out).toContain(": trusted");
    const cacheDir = join(home, "projects", readdirSync(join(home, "projects"))[0] as string, "cache");
    const [cacheFile] = readdirSync(cacheDir);
    expect(cacheFile).toEndWith(".transcript.jsonl");

    // Two days later: the cache is still there and the transcript is redrawn from it.
    const age = (days: number) => {
      const t = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      utimesSync(join(cacheDir, cacheFile as string), t, t);
    };
    age(2);
    const soon = await ui(["--continue"], [say("still 42")], "\x1b[1;5H", "earlier in this session ──");
    expect(soon.screen).toContain("── earlier in this session ──");
    expect(soon.asked).toBe(false);

    // Four days later: the cache is deleted, but --continue still sends the whole conversation.
    age(4);
    const later = await ui(["--continue"], [say("yes, 42")], "what was it?\r", "yes, 42");
    expect(existsSync(join(cacheDir, cacheFile as string))).toBe(true); // recreated by this session
    expect(later.fake.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual([
      "remember 42",
      "the answer is 42",
      "what was it?",
    ]);
    expect(later.screen).toContain("rebuilt from the conversation");

    // A longer cacheRetentionDays in user settings keeps it.
    writeFileSync(join(home, "settings.json"), JSON.stringify({ cacheRetentionDays: 10 }));
    age(4);
    await call(["-p", "--model", "fake:fake", "hi"], { cwd, home, turns: [say("ok")] });
    expect(existsSync(join(cacheDir, cacheFile as string))).toBe(true);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ cacheRetentionDays: 3 }));
    await call(["-p", "--model", "fake:fake", "hi"], { cwd, home, turns: [say("ok")] });
    expect(existsSync(join(cacheDir, cacheFile as string))).toBe(false);
  });

  test("without --model, teh picks an installed model to fit the task, by rules that cost no tokens", async () => {
    const GB = 1e9;
    const installed = [
      { id: "tiny", supportsTools: true, sizeBytes: 0.4 * GB },
      { id: "chat-only", supportsTools: false, sizeBytes: 30 * GB },
      { id: "small", supportsTools: true, sizeBytes: 5 * GB },
      { id: "mid", supportsTools: true, sizeBytes: 9 * GB },
      { id: "big", supportsTools: true, sizeBytes: 20 * GB },
    ];
    const ask = async (prompt: string, models = installed, extra: string[] = []) => {
      let err = "";
      const fake = new FakeProvider([say("ok")]);
      const provider = Object.assign(fake, { listModels: async () => models });
      const home = temp();
      const code = await run(
        ["-p", ...extra, prompt],
        {
          out: () => {},
          err: (s) => (err += s),
          env: { TEH_HOME: home, HOME: home },
          cwd: temp(),
          stdin: async () => "",
        },
        { provider: () => provider as Provider },
      );
      return { code, err, fake };
    };
    const small = await ask("what does this repo do?");
    expect(small.err).toContain("› model: ollama:small · chosen for this task (S: short question)");
    // One request: choosing the model made no model call of its own.
    expect(small.fake.requests).toHaveLength(1);
    expect(small.fake.requests[0]?.model).toBe("small");
    expect(
      (await ask("add a --json flag to the export command and cover it with a test")).fake.requests[0]?.model,
    ).toBe("mid");
    expect((await ask("refactor the session store so that it can be swapped")).fake.requests[0]?.model).toBe("big");
    // A pinned model always wins, and nothing is said about choosing.
    const pinned = await ask("what does this repo do?", installed, ["--model", "ollama:big"]);
    expect(pinned.fake.requests[0]?.model).toBe("big");
    expect(pinned.err).not.toContain("chosen for this task");
    // A model too small to drive tools is used only when it is all there is.
    expect((await ask("hi", [installed[0] as (typeof installed)[0]])).fake.requests[0]?.model).toBe("tiny");
    const none = await ask("hi", [installed[1] as (typeof installed)[0]]);
    expect(none.code).toBe(2);
    expect(none.err).toContain("no installed model supports tool calling");
    expect(none.err).toContain("teh models");
  });

  test("teh sessions rm deletes one session; sessions idle past cleanupPeriodDays go at startup", async () => {
    const cwd = temp();
    const home = temp();
    await call(["-p", "--model", "fake:fake", "first"], { cwd, home, turns: [say("a")] });
    await call(["-p", "--model", "fake:fake", "second"], { cwd, home, turns: [say("b")] });
    const listed = (await call(["sessions"], { cwd, home })).out;
    const id = (prompt: string) => listed.match(new RegExp(`^ {2}(\\S+) .* ${prompt}$`, "m"))?.[1] as string;
    expect(id("first")).toBeDefined();
    const rm = await call(["sessions", "rm", id("first")], { cwd, home });
    expect(rm.out).toContain("Deleted session");
    expect((await call(["sessions"], { cwd, home })).out).not.toMatch(/ first\n/);
    expect((await call(["sessions", "rm", "nope"], { cwd, home })).code).toBe(2);
    // Age the other one past a 7-day cleanup period; the next start removes it.
    const dir = join(home, "projects", readdirSync(join(home, "projects"))[0] as string, "sessions");
    const [file] = readdirSync(dir);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    utimesSync(join(dir, file as string), old, old);
    writeFileSync(join(home, "settings.json"), JSON.stringify({ cleanupPeriodDays: 7 }));
    await call(["-p", "--model", "fake:fake", "third"], { cwd, home, turns: [say("c")] });
    const after = (await call(["sessions"], { cwd, home })).out;
    expect(after).not.toMatch(/ second\n/);
    expect(after).toMatch(/ third\n/);
  });

  test("each directory is its own project: sessions do not cross folders, even inside one repository", async () => {
    const repo = temp();
    mkdirSync(join(repo, ".git"));
    mkdirSync(join(repo, "sub"));
    const home = temp();
    await call(["-p", "--model", "fake:fake", "in the root"], { cwd: repo, home, turns: [say("a")] });
    await call(["-p", "--model", "fake:fake", "in sub"], { cwd: join(repo, "sub"), home, turns: [say("b")] });
    expect(readdirSync(join(home, "projects"))).toHaveLength(2);
    const rootSessions = (await call(["sessions"], { cwd: repo, home })).out;
    expect(rootSessions).toContain("in the root");
    expect(rootSessions).not.toContain("in sub");
    // --continue takes the latest session of this folder; without it a new session starts.
    const cont = await call(["-p", "--model", "fake:fake", "-c", "more"], {
      cwd: join(repo, "sub"),
      home,
      turns: [say("c")],
    });
    expect(cont.fake.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : i.kind))).toEqual([
      "in sub",
      "b",
      "more",
    ]);
    const fresh = await call(["-p", "--model", "fake:fake", "new"], {
      cwd: join(repo, "sub"),
      home,
      turns: [say("d")],
    });
    expect(fresh.fake.requests[0]?.items).toHaveLength(1);
    const other = await call(["-p", "--model", "fake:fake", "-c", "x"], { cwd: join(repo, "sub", ".."), home: temp() });
    expect(other.err).toContain("no earlier session in this project to continue");
  });

  test("-p streams the answer and writes a session", async () => {
    const r = await call(["-p", "--model", "fake:fake", "say hi"], { turns: [say("hi there")] });
    expect(r).toMatchObject({ code: 0, out: "hi there\n" });
    const projects = readdirSync(join(r.home, "projects"));
    expect(readdirSync(join(r.home, "projects", projects[0] as string, "sessions"))).toHaveLength(1);
  });

  test("reads the prompt from stdin and the model from TEH_MODEL", async () => {
    const r = await call(["-p"], { stdin: "from stdin\n", env: { TEH_MODEL: "fake:fake" }, turns: [say("ok")] });
    expect(r.code).toBe(0);
    expect(r.fake.requests[0]?.items[0]).toEqual({ kind: "text", role: "user", text: "from stdin" });
  });

  test("json output reports denied actions and how to allow them", async () => {
    const r = await call(["-p", "--model", "fake:fake", "--output-format", "json", "make a file"], {
      turns: [callTool("Write", { file_path: "a.txt", content: "x" }), say("I need permission to write a.txt")],
    });
    const result = JSON.parse(r.out);
    expect(result).toMatchObject({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "I need permission to write a.txt",
      num_turns: 2,
      denied_actions: ["Create a.txt (1 line)"],
    });
  });

  test("text output prints denials and the flags that would allow them", async () => {
    const r = await call(["-p", "--model", "fake:fake", "run tests"], {
      turns: [callTool("Bash", { command: "npm test" }), say("blocked")],
    });
    expect(r.err).toContain("✗ denied: Run `npm test`");
    expect(r.err).toContain("--allowedTools 'Bash(npm test:*)'");
  });

  test("--allowedTools lets an exact command run", async () => {
    const r = await call(["-p", "--model", "fake:fake", "--allowedTools", "Bash(echo ran)", "go"], {
      turns: [callTool("Bash", { command: "echo ran" }), say("done")],
    });
    expect(r.err).not.toContain("denied");
    expect(r.fake.requests[1]?.items.at(-1)).toMatchObject({ isError: false, content: expect.stringContaining("ran") });
  });

  test("stream-json emits an init line, events and a result", async () => {
    const r = await call(["-p", "--model", "fake:fake", "--output-format", "stream-json", "hi"], {
      turns: [say("yo")],
    });
    const lines = r.out
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    expect(lines[0]).toMatchObject({ type: "system", subtype: "init", model: "fake:fake" });
    expect(lines).toContainEqual({ type: "text_delta", text: "yo" });
    expect(lines.at(-1)).toMatchObject({ type: "result", result: "yo" });
  });

  test("invalid flag values exit 2", async () => {
    expect((await call(["-p", "--permission-mode", "yolo", "x"])).code).toBe(2);
    expect((await call(["-p", "--output-format", "xml", "x"])).code).toBe(2);
    expect((await call(["-p", "--max-turns", "0", "x"])).code).toBe(2);
  });

  test("models lists tool-capable models", async () => {
    const r = await call(["models"]);
    expect(r.out).toContain("fake");
    expect(r.out).toContain("tools");
  });

  test("a model without tool support is refused", async () => {
    const noTools = { ...new FakeProvider([]), id: "x", probe: async () => ({ supportsTools: false, notes: [] }) };
    let err = "";
    const code = await run(
      ["-p", "--model", "x:y", "hi"],
      { out: () => {}, err: (s) => (err += s), env: { TEH_HOME: temp() }, cwd: temp(), stdin: async () => undefined },
      { provider: () => noTools as unknown as Provider },
    );
    expect(code).toBe(1);
    expect(err).toContain("does not support tool calling");
  });

  describe("undo", () => {
    async function editedProject() {
      const cwd = temp();
      const home = temp();
      writeFileSync(join(cwd, "a.txt"), "original");
      const r = await call(["-p", "--model", "fake:fake", "--permission-mode", "acceptEdits", "change it"], {
        cwd,
        home,
        turns: [
          callTool("Read", { file_path: "a.txt" }),
          callTool("Write", { file_path: "a.txt", content: "changed" }),
          callTool("Write", { file_path: "new.txt", content: "new" }),
          say("done"),
        ],
      });
      expect(r.err).toContain("teh undo");
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed");
      return { cwd, home };
    }

    test("undo --yes puts files back and prints how to redo", async () => {
      const { cwd, home } = await editedProject();
      const list = await call(["checkpoints"], { cwd, home });
      expect(list.out).toContain("change it");
      const r = await call(["undo", "--yes"], { cwd, home });
      expect(r.code).toBe(0);
      expect(r.out).toContain("restore  a.txt");
      expect(r.out).toContain("delete   new.txt");
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("original");
      expect(readdirSync(cwd)).toEqual(["a.txt"]);

      const redo = r.out.match(/teh restore ([0-9a-f]+)/)?.[1] as string;
      expect((await call(["restore", redo, "--yes"], { cwd, home })).code).toBe(0);
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed");
    });

    test("undo asks first and changes nothing on no", async () => {
      const { cwd, home } = await editedProject();
      const r = await call(["undo"], { cwd, home, confirm: false });
      expect(r.out).toContain("Nothing changed");
      expect(readFileSync(join(cwd, "a.txt"), "utf8")).toBe("changed");
    });

    test("undo without a terminal requires --yes", async () => {
      const { cwd, home } = await editedProject();
      const r = await call(["undo"], { cwd, home });
      expect(r.code).toBe(2);
      expect(r.err).toContain("--yes");
    });

    test("undo with no history says so", async () => {
      expect((await call(["undo", "--yes"])).out).toContain("Nothing to undo");
    });
  });

  describe("resume", () => {
    test("-c continues the latest session with its history and model", async () => {
      const cwd = temp();
      const home = temp();
      await call(["-p", "--model", "fake:first", "remember 42"], { cwd, home, turns: [say("ok, 42")] });
      const r = await call(["-p", "-c", "what number?"], { cwd, home, turns: [say("42")] });
      expect(r).toMatchObject({ code: 0, out: "42\n" });
      const req = r.fake.requests[0];
      expect(req?.model).toBe("first");
      expect(req?.items.map((i) => (i.kind === "text" ? `${i.role}:${i.text}` : i.kind))).toEqual([
        "user:remember 42",
        "assistant:ok, 42",
        "user:what number?",
      ]);
      const sessions = await call(["sessions"], { cwd, home });
      expect(sessions.out).toContain("2 prompts");
      expect(sessions.out).toContain("remember 42");
    });

    test("-r picks a session by prefix; unknown ids and -c with -r are errors", async () => {
      const cwd = temp();
      const home = temp();
      const first = await call(["-p", "--model", "fake:fake", "--output-format", "json", "alpha"], {
        cwd,
        home,
        turns: [say("A")],
      });
      const id = JSON.parse(first.out).session_id as string;
      await call(["-p", "--model", "fake:fake", "beta"], { cwd, home, turns: [say("B")] });
      const r = await call(["-p", "-r", id.slice(0, 30), "again"], { cwd, home, turns: [say("A2")] });
      expect(r.fake.requests[0]?.items[0]).toEqual({ kind: "text", role: "user", text: "alpha" });
      expect((await call(["-p", "-r", "nope", "x"], { cwd, home })).code).toBe(2);
      expect((await call(["-p", "-c", "-r", id, "x"], { cwd, home })).code).toBe(2);
    });

    test("-c with no earlier session explains", async () => {
      const r = await call(["-p", "-c", "hi"]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("no earlier session");
    });
  });

  describe("rewind", () => {
    const edits = ["-p", "--model", "fake:fake", "--permission-mode", "acceptEdits"];
    const file = (cwd: string, f: string) => (existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8") : null);

    // Prompt 1 creates a.txt then b.txt in two steps; prompt 2 rewrites a.txt.
    async function history() {
      const cwd = temp();
      const home = temp();
      await call([...edits, "make files"], {
        cwd,
        home,
        turns: [
          callTool("Write", { file_path: "a.txt", content: "v1" }),
          callTool("Write", { file_path: "b.txt", content: "b" }),
          say("made"),
        ],
      });
      await call([...edits, "-c", "update a"], {
        cwd,
        home,
        turns: [
          callTool("Read", { file_path: "a.txt" }),
          callTool("Write", { file_path: "a.txt", content: "v2" }),
          say("updated"),
        ],
      });
      return { cwd, home };
    }

    test("lists titled points grouped by prompt", async () => {
      const { cwd, home } = await history();
      const r = await call(["rewind"], { cwd, home });
      expect(r.code).toBe(0);
      for (const line of [
        'Prompt 1: "make files"',
        "1  ",
        "Start of prompt 1",
        "Before: Create a.txt (1 line)",
        "Before: Create b.txt (1 line)",
        'Prompt 2: "update a"',
        "Start of prompt 2",
        "Before: Overwrite a.txt (1 line)",
        "Current state",
        "teh rewind <point>",
      ])
        expect(r.out).toContain(line);
    });

    test("rewinds code and conversation to a mid-run step, and can come back", async () => {
      const { cwd, home } = await history();
      const r = await call(["rewind", "3", "--yes"], { cwd, home });
      expect(r.code).toBe(0);
      expect(r.out).toContain("delete   b.txt");
      expect(r.out).toContain("restore  a.txt");
      expect(file(cwd, "a.txt")).toBe("v1");
      expect(file(cwd, "b.txt")).toBeNull();

      const list = (await call(["rewind"], { cwd, home })).out;
      expect(list).toContain("Before: Create b.txt (1 line)\n");
      expect(list).toContain("Start of prompt 2  (rewound)");
      expect(list).toContain("6  ");
      expect(list).toContain("Before rewinding to point 3");

      const next = await call(["-p", "-c", "what now?"], { cwd, home, turns: [say("ok")] });
      const texts = next.fake.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : i.kind));
      expect(texts).toEqual(["make files", "tool_call", "tool_result", "what now?"]);

      expect((await call(["rewind", "6", "--yes"], { cwd, home })).code).toBe(0);
      expect(file(cwd, "a.txt")).toBe("v2");
      expect(file(cwd, "b.txt")).toBe("b");
      const back = await call(["-p", "-c", "and now?"], { cwd, home, turns: [say("ok")] });
      expect(back.fake.requests[0]?.items.at(-2)).toEqual({ kind: "text", role: "assistant", text: "updated" });
    });

    test("--code-only and --conversation-only restore just one side", async () => {
      const { cwd, home } = await history();
      await call(["rewind", "4", "--code-only", "--yes"], { cwd, home });
      expect(file(cwd, "a.txt")).toBe("v1");
      const c1 = await call(["-p", "-c", "x"], { cwd, home, turns: [say("ok")] });
      expect(c1.fake.requests[0]?.items.some((i) => i.kind === "text" && i.text === "updated")).toBe(true);

      const { cwd: cwd2, home: home2 } = await history();
      const r = await call(["rewind", "4", "--conversation-only", "--yes"], { cwd: cwd2, home: home2 });
      expect(r.out).toContain("Your prompt 2 was:\n  update a");
      expect(file(cwd2, "a.txt")).toBe("v2");
      const c2 = await call(["-p", "-c", "x"], { cwd: cwd2, home: home2, turns: [say("ok")] });
      expect(c2.fake.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : i.kind)).at(-2)).toBe("made");
    });

    test("interactive: pick a point, take the default scope, confirm", async () => {
      const { cwd, home } = await history();
      const r = await call(["rewind"], { cwd, home, answers: ["1", ""], confirm: true });
      expect(r.out).toContain("What should go back?");
      expect(r.out).toContain("1  Code and conversation  (default)");
      expect(file(cwd, "a.txt")).toBeNull();
      expect(file(cwd, "b.txt")).toBeNull();
      expect(r.out).toContain("Your prompt 1 was:\n  make files");
    });

    test("cancelling at any step changes nothing", async () => {
      const { cwd, home } = await history();
      expect((await call(["rewind"], { cwd, home, answers: [""] })).out).toContain("Nothing changed");
      expect((await call(["rewind"], { cwd, home, answers: ["2", "n"] })).out).toContain("Nothing changed");
      expect((await call(["rewind", "2"], { cwd, home, answers: ["1"], confirm: false })).out).toContain(
        "Nothing changed",
      );
      expect(file(cwd, "a.txt")).toBe("v2");
    });

    test("bad input is explained", async () => {
      const { cwd, home } = await history();
      expect((await call(["rewind", "99", "--yes"], { cwd, home })).err).toContain("points run from 1 to 5");
      expect((await call(["rewind", "2"], { cwd, home })).err).toContain("--yes");
      expect((await call(["rewind", "--code-only", "--conversation-only"], { cwd, home })).code).toBe(2);
      expect((await call(["rewind"])).err).toContain("no sessions");
    });

    test("a point already matching says so", async () => {
      const { cwd, home } = await history();
      await call(["rewind", "5", "--code-only", "--yes"], { cwd, home });
      const again = await call(["rewind", "5", "--code-only", "--yes"], { cwd, home });
      expect(again.out).toContain("Files: already as they were at this point.");
      expect(again.out).toContain("Nothing to do");
    });
  });

  describe("permissions (ADR-0003)", () => {
    test("read-only commands run headlessly without any flags", async () => {
      const r = await call(["-p", "--model", "fake:fake", "look"], {
        turns: [callTool("Bash", { command: "ls -a && git status 2>/dev/null || pwd" }), say("done")],
      });
      expect(r.err).not.toContain("denied");
      expect(r.fake.requests[1]?.items.at(-1)).toMatchObject({ isError: false });
    });

    test("json output lists rules that would allow the denied actions", async () => {
      const r = await call(["-p", "--model", "fake:fake", "--output-format", "json", "build"], {
        turns: [callTool("Bash", { command: "make build" }), say("blocked")],
      });
      expect(JSON.parse(r.out)).toMatchObject({ suggested_rules: ["Bash(make build:*)"] });
    });

    test("project allow rules wait for teh trust; project deny rules apply at once", async () => {
      const cwd = temp();
      const home = temp();
      mkdirSync(join(cwd, ".claude"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude/settings.json"),
        JSON.stringify({ permissions: { allow: ["Bash(touch:*)"], deny: ["Bash(git push:*)"] } }),
      );
      const touch = () => [callTool("Bash", { command: "touch made.txt" }), say("ok")];
      const before = await call(["-p", "--model", "fake:fake", "make it"], { cwd, home, turns: touch() });
      expect(before.err).toContain("ignoring 1 allow rule(s) in project settings until you trust this folder");
      expect(before.err).toContain("denied: Run `touch made.txt`");
      expect(existsSync(join(cwd, "made.txt"))).toBe(false);

      const listed = await call(["permissions"], { cwd, home });
      expect(listed.out).toContain("not trusted");
      expect(listed.out).toContain("Bash(git push:*)");
      expect(listed.out).toContain("(ignored until trusted)");

      const t = await call(["trust"], { cwd, home });
      expect(t.out).toContain("Bash(touch:*)");
      const after = await call(["-p", "--model", "fake:fake", "make it"], { cwd, home, turns: touch() });
      expect(after.err).not.toContain("denied");
      expect(existsSync(join(cwd, "made.txt"))).toBe(true);

      const push = await call(["-p", "--model", "fake:fake", "--permission-mode", "bypassPermissions", "push"], {
        cwd,
        home,
        turns: [callTool("Bash", { command: "git push origin main" }), say("no")],
      });
      expect(push.err).toContain("blocked by rule Bash(git push:*)");

      await call(["trust", "--revoke"], { cwd, home });
      expect((await call(["permissions"], { cwd, home })).out).toContain("not trusted");
    });

    test("project hooks run only once the folder is trusted; teh hooks lists them", async () => {
      const cwd = temp();
      const home = temp();
      const hookScript = (name: string, body: string) => {
        writeFileSync(join(home, `${name}.ts`), body);
        return `"${process.execPath}" "${join(home, `${name}.ts`)}"`;
      };
      const mark = (file: string) =>
        hookScript(file, `await Bun.stdin.text(); await Bun.write(${JSON.stringify(join(cwd, file))}, "1");`);
      mkdirSync(join(cwd, ".teh"), { recursive: true });
      writeFileSync(
        join(cwd, ".teh/settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [{ hooks: [{ type: "command", command: mark("prompt.txt") }] }],
            SessionEnd: [{ hooks: [{ type: "command", command: mark("end.txt") }] }],
          },
        }),
      );
      const listed = await call(["hooks"], { cwd, home });
      expect(listed.out).toContain("Project hooks (not run until you `teh trust` this folder)");
      expect(listed.out).toContain("UserPromptSubmit");

      const before = await call(["-p", "--model", "fake:fake", "hi"], { cwd, home, turns: [say("ok")] });
      expect(before.err).toContain("2 project hook(s)");
      expect(existsSync(join(cwd, "prompt.txt"))).toBe(false);

      expect((await call(["trust"], { cwd, home })).out).toContain("Its 2 hook command(s) now run");
      const after = await call(["-p", "--model", "fake:fake", "hi"], { cwd, home, turns: [say("ok")] });
      expect(after.code).toBe(0);
      expect(existsSync(join(cwd, "prompt.txt"))).toBe(true);
      expect(existsSync(join(cwd, "end.txt"))).toBe(true);

      // User hooks run anywhere; a blocking UserPromptSubmit hook fails the run before the model is called.
      writeFileSync(
        join(home, "settings.json"),
        JSON.stringify({
          hooks: {
            UserPromptSubmit: [
              {
                hooks: [
                  { type: "command", command: hookScript("deny", `console.error("not today"); process.exit(2);`) },
                ],
              },
            ],
          },
        }),
      );
      const blocked = await call(["-p", "--model", "fake:fake", "--output-format", "json", "hi"], { cwd, home });
      expect(blocked.code).toBe(1);
      expect(JSON.parse(blocked.out)).toMatchObject({ is_error: true, stop_reason: "hook_blocked" });
    });

    test("a repo's .mcp.json servers start only once trusted; --mcp-config adds servers", async () => {
      const cwd = temp();
      const home = temp();
      const server = join(import.meta.dir, "../../core/test/fixtures/mcp-server.ts");
      const config = { mcpServers: { local: { command: process.execPath, args: [server] } } };
      writeFileSync(join(cwd, ".mcp.json"), JSON.stringify(config));
      const echo = () => [callTool("mcp__local__echo", { text: "hi" }), say("ok")];

      const listed = await call(["mcp"], { cwd, home });
      expect(listed.out).toContain("not started: run `teh trust`");

      const before = await call(["-p", "--model", "fake:fake", "--output-format", "stream-json", "go"], {
        cwd,
        home,
        turns: [say("ok")],
      });
      expect(before.err).toContain("not starting MCP server(s) local from .mcp.json until you trust this folder");
      expect(JSON.parse(before.out.split("\n")[0] as string).tools).not.toContain("mcp__local__echo");

      await call(["trust"], { cwd, home });
      const after = await call(["mcp"], { cwd, home });
      expect(after.code).toBe(0);
      expect(after.out).toContain("4 tool(s)");
      expect(after.out).toContain("· mcp__local__echo");
      const ran = await call(["-p", "--model", "fake:fake", "--allowedTools", "mcp__local", "go"], {
        cwd,
        home,
        turns: echo(),
      });
      expect(ran.code).toBe(0);
      expect(ran.err).toContain("› local: Echo");
      expect(JSON.stringify(ran.fake.requests[1]?.items.at(-1))).toContain("echo: hi");

      // --strict-mcp-config uses only --mcp-config servers.
      const other = temp();
      const strict = await call(
        [
          "-p",
          "--model",
          "fake:fake",
          "--output-format",
          "stream-json",
          "--strict-mcp-config",
          "--mcp-config",
          JSON.stringify({ mcpServers: { flagged: config.mcpServers.local } }),
          "go",
        ],
        { cwd, home, turns: [say("ok")] },
      );
      const init = JSON.parse(strict.out.split("\n")[0] as string);
      expect(init.mcp_servers).toEqual([{ name: "flagged", status: "connected" }]);
      expect(init.tools).toContain("mcp__flagged__echo");
      expect(init.tools).not.toContain("mcp__local__echo");
      expect(other).toBeTruthy();
    });

    test("--sandbox is validated, and an untrusted project can only tighten the sandbox", async () => {
      expect((await call(["--sandbox", "maybe", "-p", "x"])).err).toContain("--sandbox must be one of");
      const cwd = temp();
      const home = temp();
      mkdirSync(join(cwd, ".teh"), { recursive: true });
      writeFileSync(join(cwd, ".teh/settings.json"), JSON.stringify({ sandbox: { enabled: "off", network: false } }));
      const listed = await call(["permissions"], { cwd, home });
      if (process.platform === "darwin" || listed.out.includes("bubblewrap")) {
        // "off" from an untrusted project is ignored; network false is honoured.
        expect(listed.out).toMatch(/seatbelt|bubblewrap/);
        expect(listed.out).toContain("network off");
        await call(["trust"], { cwd, home });
        expect((await call(["permissions"], { cwd, home })).out).toContain("  none");
      }
      expect((await call(["permissions", "--sandbox", "off"], { cwd, home })).out).toContain("  none");
    });

    test("a command's allowed-tools grant applies once loaded, for trusted projects only", async () => {
      const cwd = temp();
      const home = temp();
      mkdirSync(join(cwd, ".claude/commands"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude/commands/mk.md"),
        "---\nallowed-tools: Bash(touch:*), Bash(mkdir:*)\n---\nCreate the file.\n",
      );
      const turns = () => [callTool("Bash", { command: "touch granted.txt" }), say("ok")];
      const untrusted = await call(["-p", "--model", "fake:fake", "/mk"], { cwd, home, turns: turns() });
      expect(untrusted.err).toContain("allowed-tools of project skill(s) mk");
      expect(existsSync(join(cwd, "granted.txt"))).toBe(false);
      await call(["trust"], { cwd, home });
      const plain = await call(["-p", "--model", "fake:fake", "no skill"], { cwd, home, turns: turns() });
      expect(plain.err).toContain("denied");
      const trusted = await call(["-p", "--model", "fake:fake", "/mk"], { cwd, home, turns: turns() });
      expect(trusted.err).not.toContain("denied");
      expect(existsSync(join(cwd, "granted.txt"))).toBe(true);
    });
  });

  describe("output styles", () => {
    test("--output-style puts the style in the system prompt and is kept on resume", async () => {
      const cwd = temp();
      const home = temp();
      const r = await call(["-p", "--model", "fake:fake", "--output-style", "Explanatory", "hi"], {
        cwd,
        home,
        turns: [say("ok")],
      });
      expect(r.err).toContain("› output style: explanatory");
      expect(r.fake.requests[0]?.system).toContain('<output_style name="explanatory">');
      const again = await call(["-p", "--model", "fake:fake", "-c", "more"], { cwd, home, turns: [say("ok")] });
      expect(again.fake.requests[0]?.system).toContain('<output_style name="explanatory">');
      const plain = await call(["-p", "--model", "fake:fake", "--output-style", "default", "-c", "x"], {
        cwd,
        home,
        turns: [say("ok")],
      });
      expect(plain.fake.requests[0]?.system).not.toContain("<output_style");
    });

    test("settings choose a style; unknown names are rejected with the list", async () => {
      const cwd = temp();
      const home = temp();
      mkdirSync(join(cwd, ".teh"), { recursive: true });
      writeFileSync(join(cwd, ".teh/settings.json"), JSON.stringify({ outputStyle: "learning" }));
      const r = await call(["-p", "--model", "fake:fake", "hi"], { cwd, home, turns: [say("ok")] });
      expect(r.fake.requests[0]?.system).toContain("TODO(human)");
      const listed = await call(["styles"], { cwd, home });
      expect(listed.out).toMatch(/\* learning/);
      const bad = await call(["-p", "--model", "fake:fake", "--output-style", "pirate", "hi"], { cwd, home });
      expect(bad.code).toBe(2);
      expect(bad.err).toContain('no output style named "pirate"');
      expect(bad.err).toContain("default, explanatory, learning");
    });
  });

  describe("skills", () => {
    function withSkills() {
      const cwd = temp();
      const home = temp();
      mkdirSync(join(home, ".claude/skills/human"), { recursive: true });
      writeFileSync(
        join(home, ".claude/skills/human/SKILL.md"),
        "---\nname: human\ndescription: Rewrite prose so it reads as human.\n---\nCut the filler.\n",
      );
      mkdirSync(join(cwd, ".claude/commands"), { recursive: true });
      writeFileSync(
        join(cwd, ".claude/commands/fix.md"),
        "---\nargument-hint: <issue>\n---\nFix issue $ARGUMENTS and add a test.\n",
      );
      return { cwd, home };
    }

    test("teh skills lists them with how to run each", async () => {
      const r = await call(["skills"], withSkills());
      expect(r.out).toContain("/human");
      expect(r.out).toContain("user skill");
      expect(r.out).toContain("/fix <issue>");
      expect(r.out).toContain("project command");
    });

    test("/name runs a skill or command", async () => {
      const dirs = withSkills();
      const r = await call(["-p", "--model", "fake:fake", "/fix 123"], { ...dirs, turns: [say("fixed")] });
      expect(r.fake.requests[0]?.items[0]).toEqual({
        kind: "text",
        role: "user",
        text: "Fix issue 123 and add a test.",
      });
      const h = await call(["-p", "--model", "fake:fake", "/human tidy README.md"], { ...dirs, turns: [say("ok")] });
      const first = h.fake.requests[0]?.items[0];
      const text = first?.kind === "text" ? first.text : "";
      expect(text).toContain("Cut the filler.");
      expect(text).toContain("ARGUMENTS: tidy README.md");
      expect(h.fake.requests[0]?.system).toContain("- human: Rewrite prose so it reads as human.");
    });

    test("an unknown /name suggests close matches and is not sent", async () => {
      const r = await call(["-p", "--model", "fake:fake", "/humna x"], withSkills());
      expect(r.code).toBe(2);
      expect(r.err).toContain("did you mean /human");
      expect(r.fake.requests).toHaveLength(0);
    });

    test("a prompt that starts with a path is sent as it is", async () => {
      const r = await call(["-p", "--model", "fake:fake", "/tmp/a.txt looks wrong"], {
        ...withSkills(),
        turns: [say("ok")],
      });
      expect(r.fake.requests[0]?.items[0]).toMatchObject({ text: "/tmp/a.txt looks wrong" });
    });
  });

  test("--skill-router embed adds a hint after the prompt and logs it", async () => {
    const cwd = temp();
    const home = temp();
    mkdirSync(join(home, ".claude/skills/human"), { recursive: true });
    writeFileSync(
      join(home, ".claude/skills/human/SKILL.md"),
      "---\nname: human\ndescription: rewrite prose\n---\nbody\n",
    );
    const fake = new FakeProvider([say("ok")]);
    const withEmbed = Object.assign(fake, {
      embed: async (_m: string, inputs: string[]) => inputs.map((s) => [s.includes("rewrite") ? 1 : 0, 1]),
    });
    let err = "";
    await run(
      ["-p", "--model", "fake:fake", "--skill-router", "embed", "rewrite my intro"],
      { out: () => {}, err: (s) => (err += s), env: { TEH_HOME: home, HOME: home }, cwd, stdin: async () => undefined },
      { provider: () => withEmbed as Provider },
    );
    expect(err).toContain("skill router suggests human");
    expect(fake.requests[0]?.items.map((i) => (i.kind === "text" ? i.text : ""))).toEqual([
      "rewrite my intro",
      expect.stringContaining("Skill router: these skills look relevant to this request: human"),
    ]);
    const bad = await call(["-p", "--model", "fake:fake", "--skill-router", "embed+confirm", "x"]);
    expect(bad.err).toContain("TEH_SKILL_ROUTER_MODEL");
  });
});
