import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AUTH_ISSUER,
  AuthError,
  authorizeUrl,
  ChatGPTCredentials,
  type ChatGPTTokens,
  DYNAMIC_CLIENT,
  hostId,
  MemoryStore,
  pkce,
  verifyIdToken,
} from "../src";
import { fakeAuthServer, idToken } from "./auth-helpers";

describe("Sign in with ChatGPT", () => {
  test("authorize URL: first sign-in registers with a name hint; later ones reuse the client", () => {
    const { challenge } = pkce();
    const first = new URL(
      authorizeUrl({
        clientId: DYNAMIC_CLIENT,
        redirectUri: "http://127.0.0.1:1455/auth/callback",
        state: "S",
        nonce: "N",
        challenge,
        hostId: "urn:uuid:x",
      }),
    );
    expect(first.origin + first.pathname).toBe("https://auth.openai.com/api/accounts/authorize");
    const q = first.searchParams;
    expect(q.get("client_id")).toBe("dynamic_agent_client");
    expect(q.get("agent_name_hint")).toBe("The Everything Harness");
    expect(q.get("ext_agent_host_id")).toBe("urn:uuid:x");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("resource")).toBe("https://api.openai.com/v1");
    expect(q.get("scope")?.split(" ")).toContain("chatgpt.tokens.use.direct");
    const again = new URL(
      authorizeUrl({
        clientId: "oaiapp_1",
        redirectUri: "http://127.0.0.1:5000/auth/callback",
        state: "S",
        nonce: "N",
        challenge,
        hostId: "urn:uuid:x",
        idTokenHint: "old",
      }),
    ).searchParams;
    expect(again.get("agent_name_hint")).toBeNull();
    expect(again.get("id_token_hint")).toBe("old");
  });

  test("the host id is created once and kept", () => {
    const home = mkdtempSync(join(tmpdir(), "teh-host-"));
    const a = hostId(home);
    expect(a).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(hostId(home)).toBe(a);
    expect(readFileSync(join(home, "host-id"), "utf8").trim()).toBe(a);
  });

  test("ID tokens: signature, audience and nonce are checked", async () => {
    const { f } = fakeAuthServer();
    const claims = { iss: AUTH_ISSUER, aud: "oaiapp_1", sub: "u", exp: Math.floor(Date.now() / 1000) + 60, nonce: "N" };
    await expect(verifyIdToken(f, idToken(claims), { clientId: "oaiapp_1", nonce: "N" })).resolves.toMatchObject({
      sub: "u",
    });
    await expect(verifyIdToken(f, idToken(claims), { clientId: "other", nonce: "N" })).rejects.toThrow(
      /another client/,
    );
    await expect(verifyIdToken(f, idToken(claims), { clientId: "oaiapp_1", nonce: "X" })).rejects.toThrow(/nonce/);
    const forged = idToken(claims, generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey);
    await expect(verifyIdToken(f, forged, { clientId: "oaiapp_1", nonce: "N" })).rejects.toThrow(/signature/);
  });

  test("refreshes near expiry, stores the rotated refresh token, and clears on a terminal error", async () => {
    const home = mkdtempSync(join(tmpdir(), "teh-auth-"));
    let rotate = true;
    const { f, calls } = fakeAuthServer({
      refresh: (form) =>
        rotate
          ? Response.json({
              access_token: "fresh",
              refresh_token: `${form.get("refresh_token")}-next`,
              expires_in: 3600,
            })
          : Response.json({ error: "refresh_token_reused" }, { status: 400 }),
    });
    const store = new MemoryStore();
    const creds = new ChatGPTCredentials(home, store, f);
    creds.saveAccount({ clientId: "oaiapp_1", planEnabled: true });
    creds.saveTokens({ accessToken: "old", refreshToken: "r0", expiresAt: Date.now() + 30_000, scope: "x" });
    expect(await creds.accessToken()).toBe("fresh");
    expect(creds.tokens()?.refreshToken).toBe("r0-next");
    const refresh = calls.find((c) => c.form?.get("grant_type") === "refresh_token");
    expect(refresh?.form?.get("client_id")).toBe("oaiapp_1");
    expect(refresh?.form?.get("resource")).toBe("https://api.openai.com/v1");
    // Still valid: no refresh.
    expect(await creds.accessToken()).toBe("fresh");

    creds.saveTokens({ ...(creds.tokens() as ChatGPTTokens), expiresAt: Date.now() });
    rotate = false;
    const err = await creds.accessToken().catch((e) => e);
    expect(err).toBeInstanceOf(AuthError);
    expect((err as Error).message).toContain("teh login chatgpt");
    expect(creds.tokens()).toBeUndefined();
  });
});
