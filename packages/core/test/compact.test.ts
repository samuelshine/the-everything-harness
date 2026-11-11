import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentEvent, runAgent } from "../src/agent";
import {
  COMPACT_MARKER,
  compactConversation,
  cutPoint,
  estimateTokens,
  logCompaction,
  renderForSummary,
} from "../src/compact";
import { HookRunner, parseHooks } from "../src/hooks";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { conversationAt, loadSession, SessionLog } from "../src/session";
import { builtinTools } from "../src/tools";
import { type Item, ProviderError } from "../src/types";
import { tempDir } from "./helpers";

const user = (text: string): Item => ({ kind: "text", role: "user", text });
const assistant = (text: string): Item => ({ kind: "text", role: "assistant", text });
const call = (id: string, name: string, args: unknown): Item => ({ kind: "tool_call", id, name, args });
const result = (callId: string, name: string, content: string): Item => ({
  kind: "tool_result",
  callId,
  name,
  content,
});

// Three prompts, each with a tool call, padded so they have some weight.
function conversation(pad = 400): Item[] {
  const filler = "x".repeat(pad);
  return [
    user("make a.txt"),
    call("c1", "Write", { file_path: "a.txt", content: filler }),
    result("c1", "Write", "Wrote a.txt"),
    assistant(`made a.txt ${filler}`),
    user("now read b.txt"),
    call("c2", "Read", { file_path: "b.txt" }),
    result("c2", "Read", filler),
    assistant(`b.txt says ${filler}`),
    user("edit c.ts please"),
    call("c3", "Edit", JSON.stringify({ file_path: "c.ts", old_string: "a", new_string: "b" })),
    result("c3", "Edit", "edited"),
    assistant("done"),
  ];
}

describe("cutPoint", () => {
  test("keeps the recent part within budget and never separates a call from its result", () => {
    const items = conversation();
    expect(cutPoint(items, 0)).toBe(items.length);
    expect(cutPoint(items, 1_000_000)).toBe(0);
    for (let budget = 0; budget < estimateTokens({ items }); budget += 7) {
      const cut = cutPoint(items, budget);
      if (cut < items.length) expect(estimateTokens({ items: items.slice(cut) })).toBeLessThanOrEqual(budget);
      expect(items[cut]?.kind).not.toBe("tool_result");
      expect(items[cut - 1]?.kind).not.toBe("tool_call");
    }
  });
});

describe("compactConversation", () => {
  test("summarises the old part and keeps the user's requests, changed files and recent items", async () => {
    const provider = new FakeProvider([say("Goal: make three files.")]);
    const items = conversation();
    const keepTokens = estimateTokens({ items: items.slice(8) });
    const r = await compactConversation({ provider, model: "fake", items, contextWindow: 100_000, keepTokens });
    expect(r.keep).toBe(4);
    expect(r.items.slice(1)).toEqual(items.slice(8));
    const first = r.items[0];
    expect(first?.kind).toBe("text");
    const text = first?.kind === "text" ? first.text : "";
    expect(text.startsWith(COMPACT_MARKER)).toBe(true);
    expect(text).toContain("Goal: make three files.");
    expect(text).toContain("The user's requests so far, oldest first:\n- make a.txt\n- now read b.txt");
    expect(text).toContain("Files changed in the compacted part: a.txt");
    // The latest request is in the kept part, so it is not repeated.
    expect(text).not.toContain("latest request, verbatim");
    expect(r.after).toBeLessThan(r.before);
    expect(r.usage.input).toBe(10);
    // The summariser gets the conversation as text, no tools.
    const req = provider.requests[0];
    expect(req?.tools).toEqual([]);
    expect(JSON.stringify(req?.items)).toContain("[tool call] Write");
  });

  test("with nothing kept, the latest request is repeated verbatim", async () => {
    const provider = new FakeProvider([say("summary")]);
    const r = await compactConversation({
      provider,
      model: "fake",
      items: conversation(),
      contextWindow: 100_000,
      keepTokens: 0,
    });
    expect(r.items).toHaveLength(1);
    const text = r.items[0]?.kind === "text" ? r.items[0].text : "";
    expect(text).toContain("The user's latest request, verbatim:\nedit c.ts please");
    expect(text).toContain("Files changed in the compacted part: a.txt, c.ts");
  });

  test("a long conversation is read in chunks, each folding in the summary so far", async () => {
    const provider = new FakeProvider([say("first part"), say("both parts"), say("all parts")]);
    const items = conversation(3000);
    const r = await compactConversation({ provider, model: "fake", items, contextWindow: 2_000, keepTokens: 0 });
    expect(provider.requests.length).toBeGreaterThan(1);
    expect(JSON.stringify(provider.requests[1]?.items)).toContain(
      "Summary of the session before this part:\\nfirst part",
    );
    expect(r.summary).toBe(["first part", "both parts", "all parts"][provider.requests.length - 1] ?? "");
  });

  test("a second compaction carries the earlier requests forward", async () => {
    const provider = new FakeProvider([say("one"), say("two")]);
    const first = await compactConversation({
      provider,
      model: "fake",
      items: conversation(),
      contextWindow: 100_000,
      keepTokens: 0,
    });
    const second = await compactConversation({
      provider,
      model: "fake",
      items: [...first.items, user("and then d.md"), assistant("ok")],
      contextWindow: 100_000,
      keepTokens: 0,
    });
    const text = second.items[0]?.kind === "text" ? second.items[0].text : "";
    expect(text).toContain("- make a.txt\n- now read b.txt\n- edit c.ts please\n- and then d.md");
    expect(text.split(COMPACT_MARKER)).toHaveLength(2);
  });

  test("refuses when there is nothing to compact, and when the summary is empty", async () => {
    const provider = new FakeProvider([say("  ")]);
    await expect(
      compactConversation({ provider, model: "fake", items: [], contextWindow: 1000, keepTokens: 0 }),
    ).rejects.toThrow("nothing to compact");
    await expect(
      compactConversation({ provider, model: "fake", items: conversation(), contextWindow: 100_000, keepTokens: 0 }),
    ).rejects.toThrow("empty summary");
  });

  test("tool results are clipped for the summariser", () => {
    const text = renderForSummary([result("c", "Read", "y".repeat(10_000))]);
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain("characters cut");
  });
});

describe("compaction in the session log", () => {
  test("a resumed session continues from the summary; a rewind before it brings everything back", async () => {
    const cwd = tempDir();
    const log = new SessionLog(tempDir("teh-home-"), cwd, "local:test");
    const items = conversation();
    logItems(log, items);
    const r = await compactConversation({
      provider: new FakeProvider([say("summary")]),
      model: "fake",
      items,
      contextWindow: 100_000,
      keepTokens: estimateTokens({ items: items.slice(8) }),
    });
    logCompaction(log, r, "auto");
    log.append("user_message", { text: "next" });
    const loaded = loadSession(log.path);
    expect(loaded.items).toEqual([...r.items, user("next")]);
    // Prompt points from before the compaction still restore the full conversation.
    const third = loaded.points.find((p) => p.kind === "prompt" && p.prompt === 3);
    expect(third && conversationAt(log.path, third)).toEqual(items.slice(0, 8));
    const fourth = loaded.points.find((p) => p.kind === "prompt" && p.prompt === 4);
    expect(fourth && conversationAt(log.path, fourth)).toEqual(r.items);
  });
});

describe("automatic compaction in runAgent", () => {
  function setup(turns: ConstructorParameters<typeof FakeProvider>[0], history: Item[], window: number) {
    const cwd = tempDir();
    const home = tempDir("teh-home-");
    const session = new SessionLog(home, cwd, "local:test");
    // As when resuming: the history is in the session log.
    logItems(session, history);
    const provider = new FakeProvider(turns);
    const events: AgentEvent[] = [];
    return {
      cwd,
      session,
      provider,
      events,
      go: (extra: Partial<Parameters<typeof runAgent>[0]> = {}) =>
        runAgent({
          provider,
          model: "fake",
          prompt: "what next?",
          cwd,
          tools: builtinTools,
          permissions: { mode: "default", allow: [], deny: [] },
          ask: async () => false,
          session,
          history,
          contextWindow: window,
          onEvent: (e) => events.push(e),
          ...extra,
        }),
    };
  }

  test("compacts before a request that would fill the window, and logs it", async () => {
    const history = conversation(4000);
    const { provider, events, session, go } = setup([say("the summary"), say("carry on")], history, 6_000);
    const res = await go();
    expect(res.result).toBe("carry on");
    const done = events.find((e) => e.type === "compact" && e.phase === "done");
    expect(done).toMatchObject({ trigger: "auto" });
    const sent = provider.requests[1];
    const first = sent?.items[0];
    expect(first?.kind === "text" && first.text.startsWith(COMPACT_MARKER)).toBe(true);
    expect(sent?.items.at(-1)).toEqual(user("what next?"));
    expect(estimateTokens({ items: sent?.items ?? [] })).toBeLessThan(6_000 * 0.75);
    // Usage includes the summary call.
    expect(res.usage.input).toBe(20);
    expect(loadSession(session.path).items).toEqual(res.items);
  });

  test("the estimate is scaled by the tokens the provider reports", async () => {
    // Under the threshold by characters, but the provider counts three times as many tokens.
    const history = conversation(1500);
    const window = 12_000;
    const heavy = (n: number) => () => [
      { type: "tool_call" as const, id: `r${n}`, name: "Read", args: { file_path: "missing.txt" } },
      { type: "usage" as const, usage: { input: n, cachedRead: 0, cacheWrite: 0, output: 5 } },
      { type: "stop" as const, reason: "tool_use" as const },
    ];
    const plain = setup([heavy(1), say("done")], history, window);
    await plain.go();
    expect(plain.events.some((e) => e.type === "compact")).toBe(false);
    const scaled = setup([heavy(30_000), say("summary"), say("done")], history, window);
    await scaled.go();
    expect(scaled.events.some((e) => e.type === "compact" && e.phase === "done")).toBe(true);
    // A later run can start from the scale an earlier one learnt (AgentResult.tokenScale).
    const next = setup([say("summary"), say("done")], history, window);
    await next.go({ tokenScale: 10 });
    expect(next.events.some((e) => e.type === "compact" && e.phase === "done")).toBe(true);
  });

  test("does nothing below the threshold, or when autoCompact is off", async () => {
    const small = setup([say("fine")], conversation(10), 100_000);
    await small.go();
    expect(small.events.some((e) => e.type === "compact")).toBe(false);
    const off = setup([say("fine")], conversation(4000), 6_000);
    await off.go({ autoCompact: false });
    expect(off.events.some((e) => e.type === "compact")).toBe(false);
  });

  test("a request refused as too long is compacted and sent once more", async () => {
    const tooLong = () => {
      throw new ProviderError("context_exceeded", "request is too long");
    };
    const { provider, events, go } = setup([tooLong, say("summary"), say("ok")], conversation(), 100_000);
    const res = await go();
    expect(res.result).toBe("ok");
    expect(events.filter((e) => e.type === "compact" && e.phase === "done")).toHaveLength(1);
    expect(provider.requests).toHaveLength(3);
    // Refused twice: the error stands.
    const again = setup([tooLong, say("summary"), tooLong], conversation(), 100_000);
    await expect(again.go()).rejects.toThrow("too long");
  });

  test("compaction mid-run keeps the tool loop going, with PreCompact and SessionStart hooks", async () => {
    const big = `${"z".repeat(100)}\n`.repeat(300);
    const { cwd, provider, events, session, go } = setup(
      [callTool("Read", { file_path: "big.txt" }), say("summary of the read"), say("read it")],
      [],
      10_000,
    );
    writeFileSync(join(cwd, "big.txt"), big);
    const hooks = new HookRunner({
      config: parseHooks(
        {
          PreCompact: [{ matcher: "auto", hooks: [{ type: "command", command: hookScript(cwd, "pre", "pre.json") }] }],
          SessionStart: [
            { matcher: "compact", hooks: [{ type: "command", command: hookScript(cwd, "start", "", "remember X") }] },
          ],
        },
        "test",
      ).config,
      cwd,
      projectRoot: cwd,
      sessionId: session.id,
      transcriptPath: session.path,
      env: { PATH: process.env.PATH },
    });
    const res = await go({ hooks });
    expect(res.result).toBe("read it");
    expect(events.some((e) => e.type === "compact" && e.phase === "done")).toBe(true);
    expect(JSON.parse(readFileSync(join(cwd, "pre.json"), "utf8"))).toMatchObject({
      hook_event_name: "PreCompact",
      trigger: "auto",
    });
    const last = provider.requests[2]?.items ?? [];
    expect(last.at(-1)).toEqual({ kind: "text", role: "user", text: "SessionStart hook: remember X" });
    expect(loadSession(session.path).items).toEqual(res.items);
  });
});

function logItems(log: SessionLog, items: Item[]) {
  for (const item of items) {
    if (item.kind === "text" && item.role === "user") log.append("user_message", { text: item.text });
    else if (item.kind === "tool_result") log.append("tool_result", item);
    else log.append("assistant_item", item);
  }
}

// A hook command that runs a small Bun script: optionally saves its input, prints `out`.
function hookScript(dir: string, name: string, saveTo: string, out = ""): string {
  const path = join(dir, `${name}.ts`);
  writeFileSync(
    path,
    `const input = await Bun.stdin.text();\n${saveTo ? `await Bun.write(${JSON.stringify(join(dir, saveTo))}, input);\n` : ""}${out ? `console.log(${JSON.stringify(out)});\n` : ""}`,
  );
  return `"${process.execPath}" "${path}"`;
}
