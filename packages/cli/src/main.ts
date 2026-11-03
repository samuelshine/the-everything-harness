#!/usr/bin/env bun
import { run } from "./cli";

const code = await run(process.argv.slice(2), {
  out: (s) => process.stdout.write(s),
  err: (s) => process.stderr.write(s),
});
process.exit(code);
