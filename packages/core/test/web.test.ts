import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runAgent } from "../src/agent";
import { decide, parseRules, suggestRule } from "../src/permissions";
import { callTool, FakeProvider, say } from "../src/providers/fake";
import { builtinTools } from "../src/tools";
import type { Access } from "../src/tools/tool";
import {
  clearWebCache,
  domainRuleMatches,
  htmlToMarkdown,
  parseDuckDuckGo,
  parseUrl,
  webFetchTool,
  webSearchTool,
} from "../src/tools/web";
import { tempDir, toolContext } from "./helpers";

const LONG = "Lorem ipsum dolor sit amet. ".repeat(120);
const PAGE = `<!doctype html><html><head><title>Widget docs</title><script>alert(1)</script><style>p{}</style></head>
<body><nav><a href="/">Home</a></nav><main>
<h1>Install &amp; use</h1>
<p>Run <code>npm i widget</code> to install. See <a href="/guide">the guide</a> or <a href="#top">top</a>.</p>
<ul><li>Fast</li><li><strong>Small</strong></li></ul>
<pre><code class="language-js">const w = widget();
w.go(1 &lt; 2);</code></pre>
<p>${LONG}</p>
</main><footer>Footer stuff</footer></body></html>`;

let server: ReturnType<typeof Bun.serve>;
let base = "";

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url);
      if (u.pathname === "/page")
        return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (u.pathname === "/short")
        return new Response("<p>tiny page</p>", { headers: { "content-type": "text/html" } });
      if (u.pathname === "/moved") return Response.redirect(`${base}/short`, 301);
      if (u.pathname === "/away") return Response.redirect("https://example.org/elsewhere", 302);
      if (u.pathname === "/json") return Response.json({ ok: true });
      if (u.pathname === "/zip")
        return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/zip" } });
      if (u.pathname === "/search")
        return Response.json({
          results: [
            { title: "Bun docs", url: "https://bun.sh/docs", content: "Bun is fast" },
            { title: "Spam", url: "https://spam.example/x", content: "buy" },
            { title: "Sub", url: "https://api.bun.sh/x", content: "api" },
          ],
        });
      return new Response("nope", { status: 404 });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

describe("htmlToMarkdown", () => {
  test("keeps the main content as Markdown and drops scripts, styles and chrome", () => {
    const { title, markdown } = htmlToMarkdown(PAGE, "https://widget.dev/docs/");
    expect(title).toBe("Widget docs");
    expect(markdown).toStartWith("# Install & use");
    expect(markdown).toContain("Run `npm i widget` to install. See [the guide](https://widget.dev/guide) or top.");
    expect(markdown).toContain("- Fast\n- **Small**");
    expect(markdown).toContain("```js\nconst w = widget();\nw.go(1 < 2);\n```");
    for (const gone of ["alert", "p{}", "Home", "Footer"]) expect(markdown).not.toContain(gone);
  });

  test("without a main element, nav and footer are dropped; numeric entities decode", () => {
    const { markdown } = htmlToMarkdown("<nav>menu</nav><p>caf&#233; &#x2713;</p><footer>f</footer>");
    expect(markdown).toBe("café ✓");
  });
});

describe("parseUrl", () => {
  test("upgrades http except for local servers; refuses other schemes and credentials", () => {
    expect(parseUrl("http://example.com/a").href).toBe("https://example.com/a");
    expect(parseUrl("http://localhost:3000/").protocol).toBe("http:");
    expect(parseUrl("http://127.0.0.1:8080/").protocol).toBe("http:");
    expect(() => parseUrl("ftp://x.org")).toThrow("only http");
    expect(() => parseUrl("https://u:p@x.org")).toThrow("credentials");
    expect(() => parseUrl("not a url")).toThrow("not a valid URL");
  });
});

describe("WebFetch", () => {
  const run = (url: string, helper?: (r: { prompt: string; content: string }) => Promise<string>) => {
    clearWebCache();
    const ctx = toolContext(tempDir(), helper ? { webHelper: helper } : {});
    return webFetchTool.run(webFetchTool.parse({ url, prompt: "how to install?" }), ctx);
  };

  test("a long page goes to the helper with the prompt; the answer comes back marked untrusted", async () => {
    let seen = { prompt: "", content: "" };
    const r = await run(`${base}/page`, async (req) => {
      seen = req;
      return "npm i widget";
    });
    expect(seen.prompt).toBe("how to install?");
    expect(seen.content).toContain("# Install & use");
    expect(r.content).toContain(`${base}/page — Widget docs`);
    expect(r.content).toContain("untrusted");
    expect(r.content.trim().endsWith("npm i widget")).toBe(true);
  });

  test("short pages, and pages when the helper fails, come back as Markdown", async () => {
    expect((await run(`${base}/short`, async () => "unused")).content).toContain("tiny page");
    const failed = await run(`${base}/page`, async () => {
      throw new Error("model down");
    });
    expect(failed.content).toContain("Run `npm i widget`");
    expect((await run(`${base}/json`)).content).toContain('{"ok":true}');
  });

  test("follows redirects on the same host, reports ones to another host, and reports errors", async () => {
    expect((await run(`${base}/moved`)).content).toContain("tiny page");
    const away = await run(`${base}/away`);
    expect(away.isError).toBeUndefined();
    expect(away.content).toContain("redirects to a different host: https://example.org/elsewhere");
    expect(await run(`${base}/missing`)).toMatchObject({ isError: true, content: `${base}/missing returned HTTP 404` });
    expect((await run(`${base}/zip`)).content).toContain("application/zip, which WebFetch cannot read");
  });

  test("access names the host for the permission check", () => {
    const a = webFetchTool.access(webFetchTool.parse({ url: "https://docs.rs/x", prompt: "p" }), toolContext("/"));
    expect(a).toEqual({ kind: "network", host: "docs.rs", summary: "Fetch https://docs.rs/x" });
  });
});

describe("WebSearch", () => {
  test("parses DuckDuckGo's HTML results, unwrapping its redirect links and skipping ads", () => {
    const html = `
      <div class="result results_links"><a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fbun.sh%2Fdocs&amp;rut=x">Bun <b>docs</b></a>
      <a class="result__snippet" href="#">Bun is a <b>fast</b> runtime</a></div>
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result"><a class="result__a" href="https://example.com/">Example</a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([
      { title: "Bun docs", url: "https://bun.sh/docs", snippet: "Bun is a fast runtime" },
      { title: "Example", url: "https://example.com/", snippet: "" },
    ]);
  });

  test("queries a SearXNG instance and filters by domain", async () => {
    const ctx = toolContext(tempDir(), { webSearch: { engine: "searxng", url: base } });
    const all = await webSearchTool.run(webSearchTool.parse({ query: "bun runtime" }), ctx);
    expect(all.content).toContain('Results for "bun runtime" (searxng)');
    expect(all.content).toContain("1. Bun docs\n   https://bun.sh/docs\n   Bun is fast");
    const only = await webSearchTool.run(
      webSearchTool.parse({ query: "bun runtime", allowed_domains: ["bun.sh"], blocked_domains: ["api.bun.sh"] }),
      ctx,
    );
    expect(only.content).toContain("bun.sh/docs");
    expect(only.content).not.toContain("spam");
    expect(only.content).not.toContain("api.bun.sh");
    expect(webSearchTool.access(webSearchTool.parse({ query: "q1" }), ctx)).toMatchObject({
      kind: "network",
      host: `127.0.0.1:${server.port}`,
    });
    const broken = await webSearchTool.run(
      webSearchTool.parse({ query: "x y" }),
      toolContext(tempDir(), { webSearch: { engine: "brave" } }),
    );
    expect(broken).toMatchObject({
      isError: true,
      content: "search failed: set BRAVE_SEARCH_API_KEY to use the Brave engine",
    });
  });
});

describe("network permissions", () => {
  const cwd = tempDir();
  const ctx = toolContext(cwd);
  const fetchDocs: Access = { kind: "network", host: "docs.rs", summary: "Fetch https://docs.rs/x" };
  const config = (allow: string[] = [], deny: string[] = [], mode = "default" as const) => ({
    mode,
    allow: parseRules(allow),
    deny: parseRules(deny),
  });

  test("asks by default, in every mode but bypass, and suggests a domain rule", () => {
    expect(decide("WebFetch", fetchDocs, config(), ctx)).toMatchObject({
      behavior: "ask",
      suggestion: "WebFetch(domain:docs.rs)",
    });
    expect(decide("WebFetch", fetchDocs, { ...config(), mode: "acceptEdits" }, ctx).behavior).toBe("ask");
    expect(decide("WebFetch", fetchDocs, { ...config(), mode: "plan" }, ctx).behavior).toBe("ask");
    expect(decide("WebFetch", fetchDocs, { ...config(), mode: "bypassPermissions" }, ctx).behavior).toBe("allow");
    expect(suggestRule("WebSearch", { kind: "network", host: "html.duckduckgo.com", summary: "" })).toBe("WebSearch");
  });

  test("domain rules allow exactly that host, or subdomains with *.; deny wins", () => {
    expect(decide("WebFetch", fetchDocs, config(["WebFetch(domain:docs.rs)"]), ctx).behavior).toBe("allow");
    expect(decide("WebFetch", fetchDocs, config(["WebFetch(domain:rs)"]), ctx).behavior).toBe("ask");
    expect(decide("WebFetch", fetchDocs, config(["WebFetch"]), ctx).behavior).toBe("allow");
    expect(decide("WebFetch", fetchDocs, config(["WebFetch"], ["WebFetch(domain:docs.rs)"]), ctx).behavior).toBe(
      "deny",
    );
    expect(decide("WebSearch", fetchDocs, config(["WebFetch"]), ctx).behavior).toBe("ask");
    expect(decide("WebSearch", fetchDocs, config(["WebSearch"]), ctx).behavior).toBe("allow");
    expect(domainRuleMatches("domain:*.rust-lang.org", "doc.rust-lang.org")).toBe(true);
    expect(domainRuleMatches("domain:*.rust-lang.org", "rust-lang.org")).toBe(true);
    expect(domainRuleMatches("domain:*.rust-lang.org", "evilrust-lang.org")).toBe(false);
    expect(domainRuleMatches("domain:localhost", "localhost:3000")).toBe(true);
    expect(domainRuleMatches("docs.rs", "docs.rs")).toBe(false);
  });
});

describe("WebFetch in the agent", () => {
  test("the page is read by the helper model; its tokens count in usage, not in the conversation", async () => {
    clearWebCache();
    const provider = new FakeProvider([
      callTool("WebFetch", { url: `${base}/page`, prompt: "install command?" }),
      say("Run npm i widget."),
      say("You install it with npm i widget."),
    ]);
    const res = await runAgent({
      provider,
      model: "fake",
      prompt: "how do I install widget?",
      cwd: tempDir(),
      tools: builtinTools,
      permissions: { mode: "default", allow: parseRules(["WebFetch(domain:127.0.0.1)"]), deny: [] },
      ask: async () => false,
    });
    expect(res.result).toBe("You install it with npm i widget.");
    const helper = provider.requests[1];
    expect(helper?.tools).toEqual([]);
    expect(JSON.stringify(helper?.items)).toContain("Request: install command?");
    const result = res.items.find((i) => i.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.content).toContain("Run npm i widget.");
    expect(result?.kind === "tool_result" && result.content).not.toContain("Lorem ipsum");
    expect(res.usage.input).toBe(20);
  });

  test("headless runs without a rule are refused, and nothing is fetched", async () => {
    const provider = new FakeProvider([callTool("WebSearch", { query: "anything" }), say("ok")]);
    const res = await runAgent({
      provider,
      model: "fake",
      prompt: "search",
      cwd: tempDir(),
      tools: builtinTools,
      permissions: { mode: "default", allow: [], deny: [] },
      ask: async () => false,
    });
    const result = res.items.find((i) => i.kind === "tool_result");
    expect(result?.kind === "tool_result" && result.content).toStartWith("Permission denied: Search");
  });
});
