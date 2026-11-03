import { describe, expect, test } from "bun:test";
import { VERSION } from "@everything-harness/core";
import { run, USAGE } from "../src/cli";

async function call(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await run(argv, { out: (s) => (out += s), err: (s) => (err += s) });
  return { code, out, err };
}

describe("teh cli", () => {
  test("--version prints the core version", async () => {
    expect(await call("--version")).toEqual({ code: 0, out: `teh ${VERSION}\n`, err: "" });
  });

  test("no arguments prints usage", async () => {
    expect(await call()).toEqual({ code: 0, out: USAGE, err: "" });
  });

  test("unknown option exits 2 with usage on stderr", async () => {
    const r = await call("--nope");
    expect(r.code).toBe(2);
    expect(r.err).toContain("unknown option '--nope'");
  });

  test("--print without a prompt exits 2", async () => {
    expect((await call("-p")).code).toBe(2);
  });

  test("--print is not implemented yet", async () => {
    const r = await call("-p", "hello");
    expect(r.code).toBe(1);
    expect(r.err).toContain("not implemented");
  });
});
