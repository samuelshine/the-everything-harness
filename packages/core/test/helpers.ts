import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolContext } from "../src/tools/tool";

export function tempDir(prefix = "teh-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function toolContext(cwd: string, extra: Partial<ToolContext> = {}): ToolContext {
  return { cwd, workspaceRoots: [cwd], readState: new Map(), ...extra };
}
