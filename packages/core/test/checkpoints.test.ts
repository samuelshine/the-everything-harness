import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { CheckpointStore, MAX_SNAPSHOT_FILE_BYTES } from "../src/checkpoints";
import { tempDir } from "./helpers";

function project(files: Record<string, string> = {}) {
  const root = tempDir();
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  return { root, store: new CheckpointStore(tempDir("teh-home-"), root) };
}

const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");

async function restoreTo(store: CheckpointStore, sha: string) {
  const current = await store.snapshot("restore", "s", "before restore");
  const target = await store.find(sha);
  if (!target) throw new Error("missing checkpoint");
  const plan = await store.plan(current, target);
  await store.apply(plan);
  return { plan, current };
}

describe("CheckpointStore", () => {
  test("restores edits, deletions and new files, including ones made outside our tools", async () => {
    const { root, store } = project({ "a.txt": "one", "src/b.txt": "two" });
    const before = await store.snapshot("turn", "s", "fix the bug");

    writeFileSync(join(root, "a.txt"), "changed");
    rmSync(join(root, "src/b.txt"));
    mkdirSync(join(root, "new/deep"), { recursive: true });
    writeFileSync(join(root, "new/deep/c.txt"), "created");

    const { plan } = await restoreTo(store, before.sha);
    expect(plan.write.sort()).toEqual(["a.txt", "src/b.txt"]);
    expect(plan.remove).toEqual(["new/deep/c.txt"]);
    expect(read(root, "a.txt")).toBe("one");
    expect(read(root, "src/b.txt")).toBe("two");
    expect(existsSync(join(root, "new"))).toBe(false);
  });

  test("a restore can itself be undone", async () => {
    const { root, store } = project({ "a.txt": "v1" });
    const v1 = await store.snapshot("turn", "s", "first");
    writeFileSync(join(root, "a.txt"), "v2");
    const { current } = await restoreTo(store, v1.sha);
    expect(read(root, "a.txt")).toBe("v1");
    await restoreTo(store, current.sha);
    expect(read(root, "a.txt")).toBe("v2");
  });

  test("an unchanged tree reuses the last checkpoint; list is newest first with labels", async () => {
    const { root, store } = project({ "a.txt": "x" });
    const first = await store.snapshot("turn", "s1", "first run");
    expect((await store.snapshot("turn", "s2", "second run")).sha).toBe(first.sha);
    writeFileSync(join(root, "a.txt"), "y");
    await store.snapshot("turn", "s3", "third run\nwith a second line");
    const list = await store.list();
    expect(list.map((c) => [c.label, c.session, c.kind])).toEqual([
      ["third run with a second line", "s3", "turn"],
      ["first run", "s1", "turn"],
    ]);
  });

  test("leaves the user's git repository and ignored files alone", async () => {
    const { root, store } = project({ "a.txt": "x", ".gitignore": "secret.env\n" });
    Bun.spawnSync(["git", "init", "-q"], { cwd: root });
    const index = join(root, ".git", "index");
    const userGitBefore = existsSync(index) ? statSync(index).mtimeMs : 0;
    writeFileSync(join(root, "secret.env"), "TOKEN=1");

    const cp = await store.snapshot("turn", "s", "run");
    writeFileSync(join(root, "secret.env"), "TOKEN=2");
    writeFileSync(join(root, "a.txt"), "y");
    await restoreTo(store, cp.sha);

    expect(read(root, "a.txt")).toBe("x");
    expect(read(root, "secret.env")).toBe("TOKEN=2");
    expect(existsSync(index) ? statSync(index).mtimeMs : 0).toBe(userGitBefore);
    const log = Bun.spawnSync(["git", "log", "--oneline"], { cwd: root });
    expect(log.exitCode).not.toBe(0); // still no commits in the user's repo
  });

  test("skips files over the size limit and never overwrites them on restore", async () => {
    const { root, store } = project({ "a.txt": "x" });
    const cp = await store.snapshot("turn", "s", "run");
    writeFileSync(join(root, "big.bin"), Buffer.alloc(MAX_SNAPSHOT_FILE_BYTES + 1));
    writeFileSync(join(root, "a.txt"), "y");
    const { plan } = await restoreTo(store, cp.sha);
    expect(plan.remove).toEqual([]);
    expect(existsSync(join(root, "big.bin"))).toBe(true);
    expect(read(root, "a.txt")).toBe("x");
  });

  test("refuses to snapshot the home directory", () => {
    expect(new CheckpointStore(tempDir(), homedir()).unavailable()).toContain("too broad");
  });

  test("reports missing git", () => {
    expect(new CheckpointStore(tempDir(), tempDir(), null).unavailable()).toContain("git is not installed");
  });
});
