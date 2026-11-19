import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent } from "../src/agent";
import { estimateTokens } from "../src/compact";
import type { PermissionConfig } from "../src/permissions";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { toOllamaMessages } from "../src/providers/ollama";
import { builtinTools } from "../src/tools";
import { bashTool } from "../src/tools/bash";
import { readTool } from "../src/tools/files";
import { parsePages } from "../src/tools/media";
import { exitPlanModeTool } from "../src/tools/plan";
import { bashOutputTool, killShellTool, ShellRegistry } from "../src/tools/shells";
import type { Item } from "../src/types";
import { tempDir, toolContext } from "./helpers";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await wait(20);
}

describe("background shells", () => {
  test("Bash run_in_background returns at once; BashOutput reads new output; it reports the exit", async () => {
    const shells = new ShellRegistry();
    const ctx = toolContext(tempDir(), { shells });
    const started = await bashTool.run(
      bashTool.parse({ command: "echo one; sleep 0.3; echo two; echo oops >&2", run_in_background: true }),
      ctx,
    );
    expect(started.content).toStartWith("started bash_1 in the background");
    expect(bashTool.access(bashTool.parse({ command: "npm run dev", run_in_background: true }), ctx).summary).toBe(
      "Start `npm run dev` in the background",
    );
    const read = (filter?: string) =>
      bashOutputTool.run(bashOutputTool.parse({ bash_id: "bash_1", ...(filter ? { filter } : {}) }), ctx);
    await until(() => shells.list()[0]?.status === "exited");
    const all = await read();
    expect(all.content).toBe("one\ntwo\n[stderr] oops\n[bash_1: exited with code 0]");
    // Only new output: nothing is left.
    expect((await read()).content).toBe("(no new output)\n[bash_1: exited with code 0]");
    expect((await read("x")).content).toContain("(no new output)");
    expect((await bashOutputTool.run(bashOutputTool.parse({ bash_id: "bash_9" }), ctx)).content).toBe(
      "no background shell bash_9; shells: bash_1",
    );
  });

  test("KillShell stops a running shell; a registry passed to a run outlives it", async () => {
    const shells = new ShellRegistry();
    const ctx = toolContext(tempDir(), { shells });
    await bashTool.run(bashTool.parse({ command: "sleep 30", run_in_background: true }), ctx);
    expect(shells.running).toBe(1);
    expect((await killShellTool.run(killShellTool.parse({ shell_id: "bash_1" }), ctx)).content).toBe("killed bash_1");
    expect(shells.running).toBe(0);
    expect(shells.list()[0]?.status).toBe("killed");

    const provider = new FakeProvider([
      callTool("Bash", { command: "sleep 30", run_in_background: true }),
      (req) => {
        expect(JSON.stringify(req.items)).toContain("started bash_1");
        return say("started it");
      },
    ]);
    const own = new ShellRegistry();
    await runAgent({
      provider,
      model: "fake",
      prompt: "start a server",
      cwd: tempDir(),
      tools: builtinTools,
      permissions: { mode: "default", allow: [{ tool: "Bash" }], deny: [] },
      ask: async () => false,
      shells: own,
    });
    // A registry passed in outlives the run (the interactive UI kills it on quit).
    expect(own.running).toBe(1);
    own.killAll();
    expect(own.running).toBe(0);
  });

  test("without a registry, the tool says so", async () => {
    const r = await bashTool.run(bashTool.parse({ command: "true", run_in_background: true }), toolContext(tempDir()));
    expect(r).toMatchObject({ isError: true });
  });
});

describe("ExitPlanMode", () => {
  test("approval switches the run out of plan mode, so the next edit goes through", async () => {
    const cwd = tempDir();
    const permissions: PermissionConfig = { mode: "plan", allow: [], deny: [] };
    const plans: string[] = [];
    const provider = new FakeProvider([
      callTool("Write", { file_path: "a.txt", content: "x" }, "w1"),
      callTool("ExitPlanMode", { plan: "1. Write a.txt" }),
      callTool("Write", { file_path: "a.txt", content: "x" }, "w2"),
      say("done"),
    ]);
    const res = await runAgent({
      provider,
      model: "fake",
      prompt: "write a.txt",
      cwd,
      tools: builtinTools,
      permissions,
      ask: async () => false,
      reviewPlan: async (plan) => {
        plans.push(plan);
        return { approved: true, mode: "acceptEdits" };
      },
    });
    expect(plans).toEqual(["1. Write a.txt"]);
    expect(permissions.mode).toBe("acceptEdits");
    const results = res.items
      .filter((i) => i.kind === "tool_result")
      .map((i) => (i.kind === "tool_result" ? i.content : ""));
    expect(results[0]).toContain("plan mode");
    expect(results[1]).toContain("The user approved the plan. Permission mode is now acceptEdits");
    expect(results[2]).toContain("created a.txt");
  });

  test("a refusal keeps plan mode and passes feedback on; headless runs are told to stop with the plan", async () => {
    const no = await exitPlanModeTool.run(
      { plan: "p" },
      toolContext("/", { reviewPlan: async () => ({ approved: false, feedback: "use a test first" }) }),
    );
    expect(no.content).toBe(
      "The user did not approve the plan; stay in plan mode and revise it.\nTheir feedback: use a test first",
    );
    expect((await exitPlanModeTool.run({ plan: "p" }, toolContext("/"))).content).toContain(
      "give the plan as your final answer",
    );
  });
});

// A one-page PDF with the text "Hello PDF", with a correct cross-reference table.
function tinyPdf(): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 70 Td (Hello PDF) Tj ET";
  objects[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((o, i) => {
    offsets.push(pdf.length);
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

describe("Read: images and PDFs", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
    "base64",
  );

  test("an image comes back as an image for a vision model, and as an explanation otherwise", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "dot.png"), png);
    const args = readTool.parse({ file_path: "dot.png" });
    const seeing = await readTool.run(args, toolContext(cwd, { vision: true }));
    expect(seeing.content).toStartWith("Image dot.png (image/png");
    expect(seeing.images).toEqual([{ mediaType: "image/png", data: png.toString("base64") }]);
    const blind = await readTool.run(args, toolContext(cwd));
    expect(blind).toMatchObject({ isError: true });
    expect(blind.content).toContain("cannot see images");
  });

  test("images travel to Ollama on a user message after the tool result, and count as a fixed size", () => {
    const items: Item[] = [
      { kind: "tool_call", id: "r", name: "Read", args: {} },
      {
        kind: "tool_result",
        callId: "r",
        name: "Read",
        content: "Image",
        images: [{ mediaType: "image/png", data: "QUJD" }],
      },
    ];
    const msgs = toOllamaMessages("sys", items);
    expect(msgs.slice(2)).toEqual([
      { role: "tool", content: "Image", tool_name: "Read" },
      { role: "user", content: "(The image from Read above.)", images: ["QUJD"] },
    ]);
    const big: Item[] = [
      {
        ...(items[1] as Item & { kind: "tool_result" }),
        images: [{ mediaType: "image/png", data: "A".repeat(400_000) }],
      },
    ];
    expect(estimateTokens({ items: big })).toBeLessThan(2000);
  });

  test("PDFs are read as text with page markers, when pdftotext is installed", async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, "doc.pdf"), tinyPdf());
    const r = await readTool.run(readTool.parse({ file_path: "doc.pdf" }), toolContext(cwd));
    if (Bun.which("pdftotext")) {
      expect(r.isError).toBeUndefined();
      expect(r.content).toContain("--- page 1 ---");
      expect(r.content).toContain("Hello PDF");
    } else expect(r.content).toContain("needs pdftotext");
    expect(parsePages("2-4")).toEqual({ first: 2, last: 4 });
    expect(() => parsePages("1-30")).toThrow("at most 20 pages");
    expect(() => parsePages("x")).toThrow('"3" or "1-5"');
  });
});
