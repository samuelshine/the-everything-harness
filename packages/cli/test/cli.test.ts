import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callTool, FakeProvider, type FakeTurn, type Provider, say, VERSION } from "@everything-harness/core";
import { type Deps, run, USAGE } from "../src/cli";

const temp = () => realpathSync(mkdtempSync(join(tmpdir(), "teh-cli-")));

type CallOpts = {
  turns?: FakeTurn[];
  stdin?: string;
  env?: Record<string, string>;
  cwd?: string;
  home?: string;
  confirm?: boolean;
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
      env: { TEH_HOME: home, ...opts.env },
      cwd,
      stdin: async () => opts.stdin,
      ...(opts.confirm === undefined ? {} : { confirm: async () => opts.confirm as boolean }),
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

  test("a prompt without -p explains the UI is not built yet", async () => {
    const r = await call(["hello"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("use -p");
  });

  test("-p without a model explains how to pick one", async () => {
    const r = await call(["-p", "hi"]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("teh models");
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
      denied_actions: ["Create a.txt (1 lines)"],
    });
  });

  test("text output prints denials and the flags that would allow them", async () => {
    const r = await call(["-p", "--model", "fake:fake", "run tests"], {
      turns: [callTool("Bash", { command: "npm test" }), say("blocked")],
    });
    expect(r.err).toContain("✗ denied: Run `npm test`");
    expect(r.err).toContain('--allowedTools "Bash(<exact command>)"');
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
});
