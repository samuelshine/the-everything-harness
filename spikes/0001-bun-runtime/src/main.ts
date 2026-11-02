// ADR-0001 validation spike entrypoint.
//   spike noop          exit immediately (cold-start measurement target)
//   spike render-demo   stream 5k lines through the inline renderer (watch for flicker)
//   spike all           run every automated check and print a JSON report
import { statSync } from "node:fs";
import { InlineRenderer, NaiveRenderer, runStream } from "./render";
import { runSandboxChecks } from "./sandbox";
import { runSdkChecks } from "./sdk";

const cmd = process.argv[2] ?? "all";

if (cmd === "noop") process.exit(0);

if (cmd === "render-demo") {
  const naive = process.argv.includes("--naive");
  const r = naive ? new NaiveRenderer((s) => process.stdout.write(s)) : new InlineRenderer((s) => process.stdout.write(s));
  const ms = await runStream(r, Number(process.env.SPIKE_LINES ?? 5000), { delayMs: Number(process.env.SPIKE_DELAY_MS ?? 1) });
  process.stdout.write(`\n${naive ? "naive" : "inline"}: ${r.frames} frames, ${(r.bytes / 1024).toFixed(0)} KiB written, ${ms.toFixed(0)} ms\n`);
  process.exit(0);
}

if (cmd === "all") {
  const report: Record<string, unknown> = { platform: `${process.platform}-${process.arch}`, bun: Bun.version };

  // 1. Binary size and cold start (spawn ourselves with `noop`, median of 20).
  const compiled = !process.execPath.endsWith("/bun") && !process.execPath.endsWith("\\bun.exe");
  if (compiled) {
    const times: number[] = [];
    for (let i = 0; i < 20; i++) {
      const t = performance.now();
      Bun.spawnSync([process.execPath, "noop"]);
      times.push(performance.now() - t);
    }
    times.sort((a, b) => a - b);
    report.binary = { sizeMiB: +(statSync(process.execPath).size / 2 ** 20).toFixed(1), coldStartMedianMs: +times[10].toFixed(1), coldStartP90Ms: +times[18].toFixed(1) };
  } else {
    report.binary = "not compiled; run `bun run build` first";
  }

  // 2. Renderer: bytes written by inline-diff vs naive full redraw for 5k streamed lines.
  const sink = () => {};
  const inline = new InlineRenderer(sink);
  const naive = new NaiveRenderer(sink);
  const inlineMs = await runStream(inline, 5000);
  const naiveMs = await runStream(naive, 5000);
  report.render = {
    lines: 5000,
    inline: { frames: inline.frames, KiB: Math.round(inline.bytes / 1024), ms: Math.round(inlineMs) },
    naive: { frames: naive.frames, KiB: Math.round(naive.bytes / 1024), ms: Math.round(naiveMs) },
    note: "Flicker itself must be judged by eye: run `spike render-demo` in each terminal.",
  };

  // 3. Sandbox.
  report.sandbox = runSandboxChecks();

  // 4. SDKs.
  report.sdk = await runSdkChecks();

  const checks = [...(report.sandbox as any[]), ...(report.sdk as any[])];
  report.pass = checks.every((c) => c.ok || c.skipped);
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.pass ? 0 : 1);
}

console.error(`unknown command: ${cmd}`);
process.exit(2);
