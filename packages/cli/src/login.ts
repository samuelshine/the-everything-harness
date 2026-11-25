// `teh login chatgpt` and `teh logout chatgpt`: Sign in with ChatGPT for open-source apps
// (ADR-0009). The protocol lives in core; this file opens the browser and listens on loopback.
import { spawn } from "node:child_process";
import {
  AuthError,
  authorizeUrl,
  ChatGPTCredentials,
  DYNAMIC_CLIENT,
  exchangeCode,
  hostId,
  PLAN_SCOPE,
  pkce,
  randomToken,
  revoke,
  USAGE_URL,
  verifyIdToken,
} from "@everything-harness/core";
import type { Io } from "./cli";

const CALLBACK_PATH = "/auth/callback";
const PREFERRED_PORT = 1455;
const TIMEOUT_MS = 5 * 60 * 1000;

export type LoginDeps = {
  fetch?: typeof fetch;
  openBrowser?: (url: string) => void;
  credentials?: ChatGPTCredentials;
};

export async function login(io: Io, what: string | undefined, tehHome: string, deps: LoginDeps = {}): Promise<number> {
  if (what !== "chatgpt") {
    io.err(
      "teh: usage: teh login chatgpt\n  (Anthropic and OpenAI API keys come from ANTHROPIC_API_KEY and OPENAI_API_KEY)\n",
    );
    return 2;
  }
  const f = deps.fetch ?? fetch;
  const creds = deps.credentials ?? new ChatGPTCredentials(tehHome, undefined, f);
  const previous = creds.account();
  // Reuse the client registered on an earlier sign-in; dynamic_agent_client registers a new one.
  const clientId = previous?.clientId ?? DYNAMIC_CLIENT;
  const { verifier, challenge } = pkce();
  const state = randomToken();
  const nonce = randomToken();
  const oldTokens = creds.tokens();

  let resolveCallback: (params: URLSearchParams) => void = () => {};
  const callback = new Promise<URLSearchParams>((r) => {
    resolveCallback = r;
  });
  const handler = (req: Request) => {
    const url = new URL(req.url);
    if (url.pathname !== CALLBACK_PATH) return new Response("not found", { status: 404 });
    resolveCallback(url.searchParams);
    return new Response(
      '<!doctype html><meta charset=utf-8><title>teh</title><body style="font:16px system-ui;margin:3rem">You can close this tab and return to the terminal.</body>',
      { headers: { "content-type": "text/html; charset=utf-8" } },
    );
  };
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: PREFERRED_PORT, fetch: handler });
  } catch {
    // Only the port may change between sign-ins; any free one works.
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  }
  const redirectUri = `http://127.0.0.1:${server.port}${CALLBACK_PATH}`;
  const url = authorizeUrl({
    clientId,
    redirectUri,
    state,
    nonce,
    challenge,
    hostId: hostId(tehHome),
    ...(oldTokens?.idToken ? { idTokenHint: oldTokens.idToken } : {}),
    ...(previous?.email ? { loginHint: previous.email } : {}),
  });

  io.err("Continue with ChatGPT: opening your browser to sign in.\n");
  // The URL may carry an ID token hint, so it is printed only when the browser cannot open.
  try {
    (deps.openBrowser ?? openBrowser)(url);
  } catch {
    io.err(`Open this link to continue:\n  ${url}\n`);
  }
  io.err(`Waiting for the sign-in to finish (listening on ${redirectUri})…\n`);

  let params: URLSearchParams;
  try {
    params = await Promise.race([
      callback,
      new Promise<never>((_, reject) => setTimeout(() => reject(new AuthError("timeout", "timed out")), TIMEOUT_MS)),
    ]);
  } catch {
    io.err("teh: the sign-in did not finish within 5 minutes; run `teh login chatgpt` again\n");
    return 1;
  } finally {
    // Let the "you can close this tab" page finish sending.
    void server.stop();
  }

  if (params.get("state") !== state) {
    io.err("teh: the sign-in reply did not match this attempt (state mismatch); nothing was saved\n");
    return 1;
  }
  const error = params.get("error");
  if (error) {
    io.err(
      error === "access_denied"
        ? "teh: the sign-in was cancelled, or ChatGPT plan usage is not available for this account\n"
        : `teh: sign-in failed: ${error}${params.get("error_description") ? ` (${params.get("error_description")})` : ""}\n`,
    );
    return 1;
  }
  const issued = params.get("client_id") ?? undefined;
  if (clientId === DYNAMIC_CLIENT && !issued) {
    io.err("teh: the registration did not return a client id; run `teh login chatgpt` again\n");
    return 1;
  }
  if (clientId !== DYNAMIC_CLIENT && issued && issued !== clientId) {
    io.err("teh: the sign-in returned a different client than the one registered; nothing was saved\n");
    return 1;
  }
  const finalClient = clientId === DYNAMIC_CLIENT ? (issued as string) : clientId;
  const code = params.get("code");
  if (!code) {
    io.err("teh: the sign-in reply had no code\n");
    return 1;
  }

  try {
    const tokens = await exchangeCode(f, { clientId: finalClient, code, verifier, redirectUri });
    if (!tokens.idToken) throw new AuthError("id_token", "the token response had no ID token");
    const claims = await verifyIdToken(f, tokens.idToken, { clientId: finalClient, nonce });
    if (previous?.sub && claims.sub !== previous.sub && previous.clientId === finalClient) {
      io.err("teh: this is a different account from the one signed in before; nothing was replaced\n");
      return 1;
    }
    const planEnabled = tokens.scope.split(/\s+/).includes(PLAN_SCOPE);
    creds.saveAccount({
      clientId: finalClient,
      ...(claims.email ? { email: claims.email } : {}),
      sub: claims.sub,
      planEnabled,
    });
    creds.saveTokens(tokens);
    if (!planEnabled) {
      io.err(
        "Signed in, but ChatGPT plan usage is not enabled for this sign-in.\n  To enable it, run `teh login chatgpt` again and allow plan usage; or use an API key (OPENAI_API_KEY).\n",
      );
      return 0;
    }
    const first = !previous?.planEnabled;
    io.err(`Signed in to ChatGPT${claims.email ? ` as ${claims.email}` : ""}.\n`);
    if (first)
      io.err(
        `\nYou’re using your ChatGPT plan\n  Eligible usage in this app uses your ChatGPT plan. Manage usage in your ChatGPT settings: ${USAGE_URL}\n\n`,
      );
    io.err("Use it with: teh --model chatgpt:<model>   (`teh models` lists the models your plan offers)\n");
    return 0;
  } catch (e) {
    io.err(`teh: sign-in failed: ${(e as Error).message}\n`);
    return 1;
  }
}

export async function logout(io: Io, what: string | undefined, tehHome: string, deps: LoginDeps = {}): Promise<number> {
  if (what !== "chatgpt") {
    io.err("teh: usage: teh logout chatgpt\n");
    return 2;
  }
  const f = deps.fetch ?? fetch;
  const creds = deps.credentials ?? new ChatGPTCredentials(tehHome, undefined, f);
  const account = creds.account();
  const tokens = creds.tokens();
  if (!account || !tokens) {
    io.err("Not signed in to ChatGPT.\n");
    return 0;
  }
  try {
    await revoke(f, account.clientId, tokens.refreshToken);
  } catch (e) {
    io.err(
      `teh: warning: could not revoke the sign-in (${(e as Error).message}); removed it from this machine anyway\n`,
    );
  }
  creds.clearTokens();
  // The registered client id stays, so the next sign-in reuses it.
  creds.saveAccount({ ...account, planEnabled: false });
  io.err("Signed out of ChatGPT.\n");
  return 0;
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(cmd, args, { stdio: "ignore", detached: true });
  child.on("error", () => {});
  child.unref();
}
