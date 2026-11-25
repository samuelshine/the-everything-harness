import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatGPTCredentials, MemoryStore } from "@everything-harness/core";
import { fakeAuthServer, idToken } from "../../core/test/auth-helpers";
import type { Io } from "../src/cli";
import { login, logout } from "../src/login";

function io() {
  let err = "";
  const value: Io = {
    out: () => {},
    err: (s) => {
      err += s;
    },
    env: {},
    cwd: "/",
    stdin: async () => undefined,
  };
  return { io: value, err: () => err };
}

test("teh login chatgpt: registers, checks the ID token, stores tokens, and logout revokes", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "teh-login-")));
  let nonce = "";
  const server = fakeAuthServer();
  // The token endpoint must echo the nonce from this attempt.
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    if (String(input).endsWith("/oauth/token")) {
      const form = new URLSearchParams(String(init?.body));
      return Response.json({
        access_token: "acc",
        refresh_token: "ref",
        id_token: idToken({
          iss: "https://auth.openai.com",
          aud: form.get("client_id"),
          sub: "user-1",
          email: "a@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce,
        }),
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    return server.f(input, init);
  }) as typeof fetch;
  const creds = new ChatGPTCredentials(home, new MemoryStore(), f);
  const t = io();
  const code = await login(t.io, "chatgpt", home, {
    fetch: f,
    credentials: creds,
    // The "browser": approve at once and come back to the loopback callback.
    openBrowser: (url) => {
      const q = new URL(url).searchParams;
      nonce = q.get("nonce") ?? "";
      expect(q.get("client_id")).toBe("dynamic_agent_client");
      const back = new URL(q.get("redirect_uri") as string);
      back.searchParams.set("code", "CODE");
      back.searchParams.set("state", q.get("state") as string);
      back.searchParams.set("client_id", "oaiapp_new");
      void fetch(back).catch(() => {});
    },
  });
  expect(t.err()).toContain("Continue with ChatGPT");
  expect(code).toBe(0);
  expect(t.err()).toContain("You’re using your ChatGPT plan");
  expect(creds.account()).toEqual({ clientId: "oaiapp_new", email: "a@example.com", sub: "user-1", planEnabled: true });
  expect(creds.tokens()?.accessToken).toBe("acc");
  expect(creds.signedIn()).toBe(true);

  const out = io();
  expect(await logout(out.io, "chatgpt", home, { fetch: f, credentials: creds })).toBe(0);
  expect(server.calls.some((c) => c.url.endsWith("/revoke") && c.form?.get("token") === "ref")).toBe(true);
  expect(creds.tokens()).toBeUndefined();
  // The registered client is kept for the next sign-in.
  expect(creds.account()?.clientId).toBe("oaiapp_new");
});

test("teh login chatgpt rejects a reply from another attempt", async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "teh-login-")));
  const creds = new ChatGPTCredentials(home, new MemoryStore(), fakeAuthServer().f);
  const t = io();
  const code = await login(t.io, "chatgpt", home, {
    credentials: creds,
    openBrowser: (url) => {
      const back = new URL(new URL(url).searchParams.get("redirect_uri") as string);
      back.searchParams.set("code", "CODE");
      back.searchParams.set("state", "someone-else");
      void fetch(back).catch(() => {});
    },
  });
  expect(code).toBe(1);
  expect(t.err()).toContain("state mismatch");
  expect(creds.tokens()).toBeUndefined();
});
