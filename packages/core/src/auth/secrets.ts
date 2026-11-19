// Secret storage for sign-in tokens (ADR-0009): the macOS keychain, the Secret Service on Linux
// (secret-tool), or, where neither exists, a file only the user can read.
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface SecretStore {
  readonly kind: "keychain" | "secret-service" | "file" | "memory";
  get(account: string): string | undefined;
  set(account: string, value: string): void;
  delete(account: string): void;
}

const SERVICE = "teh";

function has(cmd: string): boolean {
  return spawnSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }).status === 0;
}

class KeychainStore implements SecretStore {
  readonly kind = "keychain" as const;
  get(account: string) {
    const r = spawnSync("security", ["find-generic-password", "-s", SERVICE, "-a", account, "-w"], {
      encoding: "utf8",
    });
    return r.status === 0 ? r.stdout.replace(/\n$/, "") : undefined;
  }
  set(account: string, value: string) {
    // -U updates an existing item. The value passes through argv briefly; `security` reads a
    // password from stdin only when attached to a terminal.
    const r = spawnSync("security", ["add-generic-password", "-U", "-s", SERVICE, "-a", account, "-w", value], {
      encoding: "utf8",
    });
    if (r.status !== 0) throw new Error(`could not save to the keychain: ${r.stderr.trim()}`);
  }
  delete(account: string) {
    spawnSync("security", ["delete-generic-password", "-s", SERVICE, "-a", account], { stdio: "ignore" });
  }
}

class SecretServiceStore implements SecretStore {
  readonly kind = "secret-service" as const;
  get(account: string) {
    const r = spawnSync("secret-tool", ["lookup", "service", SERVICE, "account", account], { encoding: "utf8" });
    return r.status === 0 && r.stdout ? r.stdout.replace(/\n$/, "") : undefined;
  }
  set(account: string, value: string) {
    const r = spawnSync(
      "secret-tool",
      ["store", `--label=${SERVICE} ${account}`, "service", SERVICE, "account", account],
      { input: value, encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`could not save to the Secret Service: ${r.stderr.trim()}`);
  }
  delete(account: string) {
    spawnSync("secret-tool", ["clear", "service", SERVICE, "account", account], { stdio: "ignore" });
  }
}

export class FileStore implements SecretStore {
  readonly kind = "file" as const;
  private readonly dir: string;
  constructor(tehHome: string) {
    this.dir = join(tehHome, "auth", "secrets");
  }
  get(account: string) {
    try {
      return readFileSync(join(this.dir, account), "utf8");
    } catch {
      return undefined;
    }
  }
  set(account: string, value: string) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    const path = join(this.dir, account);
    writeFileSync(path, value, { mode: 0o600 });
    chmodSync(path, 0o600);
  }
  delete(account: string) {
    rmSync(join(this.dir, account), { force: true });
  }
}

export class MemoryStore implements SecretStore {
  readonly kind = "memory" as const;
  private readonly values = new Map<string, string>();
  get(account: string) {
    return this.values.get(account);
  }
  set(account: string, value: string) {
    this.values.set(account, value);
  }
  delete(account: string) {
    this.values.delete(account);
  }
}

// TEH_SECRET_STORE=file forces the file store (for machines whose keychain is locked or absent).
export function secretStore(tehHome: string, env: Record<string, string | undefined> = process.env): SecretStore {
  if (env.TEH_SECRET_STORE === "file") return new FileStore(tehHome);
  if (process.platform === "darwin" && has("security")) return new KeychainStore();
  if (process.platform === "linux" && has("secret-tool")) return new SecretServiceStore();
  return new FileStore(tehHome);
}
