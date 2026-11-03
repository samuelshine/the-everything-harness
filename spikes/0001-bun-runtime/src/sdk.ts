// SDKs inside the compiled binary (ADR-0001 spike, check 4).
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export type SdkResult = { name: string; ok: boolean; detail: string };

export async function runSdkChecks(): Promise<SdkResult[]> {
  const results: SdkResult[] = [];

  // MCP: spawn the compiled echo server next to this binary (or the TS source in dev).
  const compiled = join(dirname(process.execPath), process.platform === "win32" ? "mcp-server.exe" : "mcp-server");
  const [command, args] = existsSync(compiled)
    ? [compiled, []]
    : [process.execPath, [join(import.meta.dir, "mcp-server.ts")]];
  try {
    const client = new Client({ name: "spike", version: "0.0.1" });
    await client.connect(new StdioClientTransport({ command, args }));
    const tools = await client.listTools();
    const res: any = await client.callTool({ name: "echo", arguments: { text: "hello" } });
    await client.close();
    const text = res.content?.[0]?.text ?? "";
    results.push({ name: "MCP stdio client -> server", ok: text === "echo: hello", detail: `tools=${tools.tools.map((t) => t.name).join(",")} reply="${text}"` });
  } catch (e: any) {
    results.push({ name: "MCP stdio client -> server", ok: false, detail: String(e?.message ?? e) });
  }

  // Providers: a real call if a key is present; otherwise prove the SDK loads and builds a request.
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  try {
    const a = new Anthropic({ apiKey: anthropicKey ?? "sk-ant-dummy", maxRetries: 0 });
    if (anthropicKey) {
      const m = await a.messages.create({ model: process.env.SPIKE_ANTHROPIC_MODEL ?? "claude-haiku-5-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with: ok" }] });
      results.push({ name: "Anthropic SDK live call", ok: m.content.length > 0, detail: `stop=${m.stop_reason}` });
    } else {
      await a.models.list().catch((e: any) => { if (!(e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError)) throw e; });
      results.push({ name: "Anthropic SDK loads + issues request", ok: true, detail: "no ANTHROPIC_API_KEY; request reached transport layer" });
    }
  } catch (e: any) {
    results.push({ name: "Anthropic SDK", ok: false, detail: String(e?.message ?? e) });
  }

  const openaiKey = process.env.OPENAI_API_KEY;
  try {
    const o = new OpenAI({ apiKey: openaiKey ?? "sk-dummy", maxRetries: 0 });
    if (openaiKey) {
      const r = await o.responses.create({ model: process.env.SPIKE_OPENAI_MODEL ?? "gpt-5-mini", input: "Reply with: ok", max_output_tokens: 16 });
      results.push({ name: "OpenAI SDK live call", ok: !!r.id, detail: `status=${r.status}` });
    } else {
      await o.models.list().catch((e: any) => { if (!(e instanceof OpenAI.APIError)) throw e; });
      results.push({ name: "OpenAI SDK loads + issues request", ok: true, detail: "no OPENAI_API_KEY; request reached transport layer" });
    }
  } catch (e: any) {
    results.push({ name: "OpenAI SDK", ok: false, detail: String(e?.message ?? e) });
  }

  return results;
}
