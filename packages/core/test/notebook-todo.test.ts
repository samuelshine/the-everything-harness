import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent";
import { compactConversation } from "../src/compact";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { builtinTools } from "../src/tools";
import { readTool } from "../src/tools/files";
import { latestTodos, parseTodos, todoWriteTool } from "../src/tools/todo";
import type { Item } from "../src/types";
import { tempDir, toolContext } from "./helpers";

const notebookTool = builtinTools.find((t) => t.spec.name === "NotebookEdit");
if (!notebookTool) throw new Error("NotebookEdit is not registered");
const nbTool = notebookTool;

function notebook(minor = 5) {
  return {
    nbformat: 4,
    nbformat_minor: minor,
    metadata: { language_info: { name: "python" } },
    cells: [
      { ...(minor >= 5 ? { id: "intro" } : {}), cell_type: "markdown", metadata: {}, source: ["# Title\n", "Text"] },
      {
        ...(minor >= 5 ? { id: "calc" } : {}),
        cell_type: "code",
        metadata: {},
        execution_count: 3,
        source: "x = 1 + 1\nprint(x)",
        outputs: [
          { output_type: "stream", name: "stdout", text: ["2\n"] },
          { output_type: "display_data", data: { "image/png": "iVBOR..." } },
        ],
      },
    ],
  };
}

function setup(minor = 5) {
  const cwd = tempDir();
  const path = join(cwd, "nb.ipynb");
  writeFileSync(path, JSON.stringify(notebook(minor)));
  const ctx = toolContext(cwd);
  const edit = (args: Record<string, unknown>) => nbTool.run(nbTool.parse({ notebook_path: "nb.ipynb", ...args }), ctx);
  const read = () => readTool.run(readTool.parse({ file_path: "nb.ipynb" }), ctx);
  const load = () => JSON.parse(readFileSync(path, "utf8"));
  return { path, ctx, edit, read, load };
}

describe("notebooks", () => {
  test("Read shows cells with ids, source and outputs", async () => {
    const { read } = setup();
    const r = await read();
    expect(r.content).toBe(
      '<cell id="intro" type="markdown">\n# Title\nText\n</cell>\n\n<cell id="calc" type="code" language="python">\nx = 1 + 1\nprint(x)\n<outputs>\n2\n[image/png output]\n</outputs>\n</cell>',
    );
  });

  test("NotebookEdit needs a read first, then replaces, inserts and deletes cells", async () => {
    const { edit, read, load } = setup();
    expect((await edit({ cell_id: "calc", new_source: "y = 2" })).content).toContain("with the Read tool");
    await read();
    expect((await edit({ cell_id: "calc", new_source: "y = 2\nprint(y)" })).content).toBe(
      "replaced cell calc in nb.ipynb (2 cells)",
    );
    let nb = load();
    expect(nb.cells[1]).toMatchObject({ source: ["y = 2\n", "print(y)"], outputs: [], execution_count: null });
    const ins = await edit({ cell_id: "intro", new_source: "## Setup", cell_type: "markdown", edit_mode: "insert" });
    expect(ins.content).toMatch(/^inserted markdown cell [0-9a-f]{8} after intro/);
    await edit({ new_source: "import os", cell_type: "code", edit_mode: "insert" });
    nb = load();
    expect(nb.cells.map((c: { source: string[] }) => c.source.join(""))).toEqual([
      "import os",
      "# Title\nText",
      "## Setup",
      "y = 2\nprint(y)",
    ]);
    expect(nb.cells[0]).toMatchObject({ cell_type: "code", outputs: [], execution_count: null });
    expect((await edit({ cell_id: "intro", new_source: "", edit_mode: "delete" })).content).toBe(
      "deleted cell intro in nb.ipynb (3 cells)",
    );
    expect(readFileSync(setup().path, "utf8")).toBeTruthy();
    expect((await edit({ cell_id: "nope", new_source: "x" })).content).toContain('no cell "nope"');
  });

  test("older notebooks without cell ids are addressed by position, and new cells get no id", async () => {
    const { edit, read, load } = setup(4);
    expect((await read()).content).toContain('<cell id="cell-1" type="code"');
    await edit({ cell_id: "cell-1", new_source: "z = 3" });
    await edit({ cell_id: "0", new_source: "more", cell_type: "markdown", edit_mode: "insert" });
    const nb = load();
    expect(nb.cells[2].source).toEqual(["z = 3"]);
    expect(nb.cells[1].id).toBeUndefined();
  });

  test("arguments are checked", () => {
    expect(() => nbTool.parse({ notebook_path: "a.py", cell_id: "x", new_source: "" })).toThrow(".ipynb");
    expect(() => nbTool.parse({ notebook_path: "a.ipynb", new_source: "", edit_mode: "insert" })).toThrow("cell_type");
    expect(() => nbTool.parse({ notebook_path: "a.ipynb", new_source: "" })).toThrow("cell_id is required");
  });
});

describe("TodoWrite", () => {
  test("validates, replaces the list and nudges towards one item in progress", async () => {
    const list = [
      { content: "Write tests", status: "completed" },
      { content: "Fix bug", status: "in_progress", activeForm: "Fixing the bug" },
      { content: "Update docs", status: "pending" },
    ];
    const todos = todoWriteTool.parse({ todos: list });
    expect(todoWriteTool.access(todos, toolContext("/"))).toEqual({
      kind: "read",
      paths: [],
      summary: "Update Todos (1/3 done)",
    });
    const r = await todoWriteTool.run(todos, toolContext("/"));
    expect(r.content).toBe("Todo list updated:\n[x] Write tests\n[~] Fix bug\n[ ] Update docs");
    const two = await todoWriteTool.run(
      parseTodos({
        todos: [
          { content: "a", status: "in_progress" },
          { content: "b", status: "in_progress" },
        ],
      }),
      toolContext("/"),
    );
    expect(two.content).toContain("keep one at a time");
    expect(() => parseTodos({ todos: [{ content: "", status: "pending" }] })).toThrow('needs a "content"');
    expect(() => parseTodos({ todos: [{ content: "a", status: "done" }] })).toThrow("status must be one of");
    expect(parseTodos({ todos: JSON.stringify(list) })).toHaveLength(3);
  });

  test("the latest list comes from the last TodoWrite call, and compaction carries it forward", async () => {
    const call = (todos: unknown[]): Item => ({ kind: "tool_call", id: "t", name: "TodoWrite", args: { todos } });
    const items: Item[] = [
      { kind: "text", role: "user", text: "do three things" },
      call([{ content: "one", status: "in_progress" }]),
      { kind: "tool_result", callId: "t", name: "TodoWrite", content: "ok" },
      call([
        { content: "one", status: "completed" },
        { content: "two", status: "in_progress" },
      ]),
      { kind: "tool_result", callId: "t", name: "TodoWrite", content: "ok" },
      { kind: "text", role: "assistant", text: "working" },
    ];
    expect(latestTodos(items)?.map((t) => t.status)).toEqual(["completed", "in_progress"]);
    const provider = new FakeProvider([say("s1"), say("s2")]);
    const first = await compactConversation({ provider, model: "fake", items, contextWindow: 100_000, keepTokens: 0 });
    const text = (i: Item | undefined) => (i?.kind === "text" ? i.text : "");
    expect(text(first.items[0])).toContain(
      "Your to-do list ([x] done, [~] in progress, [ ] pending):\n[x] one\n[~] two",
    );
    // A second compaction with no new TodoWrite keeps the list from the first summary.
    const second = await compactConversation({
      provider,
      model: "fake",
      items: [...first.items, { kind: "text", role: "user", text: "go on" }],
      contextWindow: 100_000,
      keepTokens: 0,
    });
    expect(text(second.items[0])).toContain("[x] one\n[~] two");
  });
});

describe("unfinished to-dos", () => {
  const list = (status: string) => ({
    todos: [
      { content: "one", status: "completed" },
      { content: "two", status },
    ],
  });
  const go = (turns: ConstructorParameters<typeof FakeProvider>[0], history: Item[] = []) => {
    const provider = new FakeProvider(turns);
    return {
      provider,
      res: runAgent({
        provider,
        model: "fake",
        prompt: "do one and two",
        cwd: tempDir(),
        tools: builtinTools,
        permissions: { mode: "default", allow: [], deny: [] },
        ask: async () => false,
        history,
      }),
    };
  };

  test("stopping with items open gets a reminder, at most twice", async () => {
    const { provider, res } = go([
      callTool("TodoWrite", list("in_progress")),
      say("stopping early"),
      say("still stopping"),
      say("really stopping"),
    ]);
    const r = await res;
    expect(r.result).toBe("really stopping");
    const reminders = provider.requests
      .map((q) => q.items.at(-1))
      .filter((i) => i?.kind === "text" && i.text.startsWith("[teh]"));
    expect(reminders).toHaveLength(2);
    expect(reminders[0]?.kind === "text" && reminders[0].text).toContain("unfinished items:\n[~] two");
  });

  test("no reminder once the list is done, or for a list from an earlier prompt", async () => {
    const done = go([callTool("TodoWrite", list("completed")), say("done")]);
    expect((await done.res).turns).toBe(2);
    const earlier: Item[] = [
      { kind: "tool_call", id: "t", name: "TodoWrite", args: list("pending") },
      { kind: "tool_result", callId: "t", name: "TodoWrite", content: "ok" },
    ];
    const later = go([say("an unrelated answer")], earlier);
    expect((await later.res).turns).toBe(1);
  });
});
