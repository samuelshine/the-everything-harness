// Sign in with ChatGPT for open-source apps (ADR-0009, [LLM-15]–[LLM-17]). This module holds the
// protocol: PKCE, the authorize URL, the code exchange, ID-token checks, refresh with rotation,
// revocation, and where credentials live. The browser and loopback listener are the CLI's.
//
// teh registers its own client (client_id=dynamic_agent_client on first sign-in) and never reads
// another app's credentials.
import {
  createHash,
  createPublicKey,
  type JsonWebKeyInput,
  randomBytes,
  randomUUID,
  verify as verifySignature,
} from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SecretStore, secretStore } from "./secrets";

export const AUTH_ISSUER = "https://auth.openai.com";
export const AUTHORIZE_URL = `${AUTH_ISSUER}/api/accounts/authorize`;
export const TOKEN_URL = `${AUTH_ISSUER}/api/accounts/oauth/token`;
export const DISCOVERY_URL = `${AUTH_ISSUER}/.well-known/openid-configuration`;
export const RESOURCE = "https://api.openai.com/v1";
export const DYNAMIC_CLIENT = "dynamic_agent_client";
export const AGENT_NAME = "The Everything Harness";
export const PLAN_SCOPE = "chatgpt.tokens.use.direct";
export const SCOPES = `openid profile email offline_access resource.invoke ${PLAN_SCOPE}`;
export const USAGE_URL = "https://chatgpt.com/settings/usage";
export const SECRET_ACCOUNT = "chatgpt";

// Not secret: kept in ~/.teh/auth/chatgpt.json so a later sign-in reuses the registered client.
export type ChatGPTAccount = { clientId: string; email?: string; sub?: string; planEnabled: boolean };

// Secret: kept in the OS keychain where there is one.
export type ChatGPTTokens = {
  accessToken: string;
  refreshToken: string;
  idToken?: string;
  expiresAt: number; // ms since epoch
  scope: string;
};

export type Fetch = typeof fetch;

const b64url = (buf: Buffer) => buf.toString("base64url");

export function pkce(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48));
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

export const randomToken = () => b64url(randomBytes(24));

// One opaque, stable id per install (ext_agent_host_id), created before the first sign-in.
export function hostId(tehHome: string): string {
  const path = join(tehHome, "host-id");
  if (existsSync(path)) {
    const id = readFileSync(path, "utf8").trim();
    if (id.startsWith("urn:uuid:")) return id;
  }
  mkdirSync(tehHome, { recursive: true });
  const id = `urn:uuid:${randomUUID()}`;
  writeFileSync(path, `${id}\n`);
  return id;
}

export function authorizeUrl(p: {
  clientId: string;
  redirectUri: string;
  state: string;
  nonce: string;
  challenge: string;
  hostId: string;
  idTokenHint?: string;
  loginHint?: string;
}): string {
  const q = new URLSearchParams({
    response_type: "code",
    client_id: p.clientId,
    redirect_uri: p.redirectUri,
    scope: SCOPES,
    resource: RESOURCE,
    state: p.state,
    nonce: p.nonce,
    code_challenge: p.challenge,
    code_challenge_method: "S256",
    ext_agent_host_id: p.hostId,
  });
  if (p.clientId === DYNAMIC_CLIENT) q.set("agent_name_hint", AGENT_NAME);
  if (p.idTokenHint) q.set("id_token_hint", p.idTokenHint);
  if (p.loginHint) q.set("login_hint", p.loginHint);
  return `${AUTHORIZE_URL}?${q}`;
}

type TokenResponse = {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

export class AuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

async function postForm(f: Fetch, url: string, form: Record<string, string>): Promise<Response> {
  return f(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form).toString(),
  });
}

async function tokenRequest(f: Fetch, form: Record<string, string>): Promise<TokenResponse> {
  const res = await postForm(f, TOKEN_URL, form);
  const text = await res.text();
  let body: TokenResponse;
  try {
    body = JSON.parse(text) as TokenResponse;
  } catch {
    throw new AuthError("bad_response", `token endpoint ${res.status}: ${text.slice(0, 200)}`);
  }
  if (!res.ok || body.error)
    throw new AuthError(
      body.error ?? `http_${res.status}`,
      body.error_description ?? body.error ?? `HTTP ${res.status}`,
    );
  return body;
}

const toTokens = (t: TokenResponse, previous?: ChatGPTTokens): ChatGPTTokens => {
  const idToken = t.id_token ?? previous?.idToken;
  return {
    accessToken: t.access_token,
    refreshToken: t.refresh_token ?? previous?.refreshToken ?? "",
    ...(idToken ? { idToken } : {}),
    expiresAt: Date.now() + (t.expires_in ?? 3600) * 1000,
    scope: t.scope ?? previous?.scope ?? "",
  };
};

export async function exchangeCode(
  f: Fetch,
  p: { clientId: string; code: string; verifier: string; redirectUri: string },
): Promise<ChatGPTTokens> {
  return toTokens(
    await tokenRequest(f, {
      grant_type: "authorization_code",
      client_id: p.clientId,
      code: p.code,
      code_verifier: p.verifier,
      redirect_uri: p.redirectUri,
      resource: RESOURCE,
    }),
  );
}

// Refresh errors after which the only fix is signing in again.
export const TERMINAL_REFRESH_ERRORS = new Set([
  "invalid_grant",
  "invalid_refresh_token",
  "token_expired",
  "refresh_token_expired",
  "refresh_token_invalidated",
  "refresh_token_reused",
]);

export async function refreshTokens(f: Fetch, clientId: string, tokens: ChatGPTTokens): Promise<ChatGPTTokens> {
  return toTokens(
    await tokenRequest(f, {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: tokens.refreshToken,
      resource: RESOURCE,
    }),
    tokens,
  );
}

type Discovery = { jwks_uri?: string; revocation_endpoint?: string; issuer?: string };

export async function discovery(f: Fetch): Promise<Discovery> {
  const res = await f(DISCOVERY_URL);
  if (!res.ok) throw new AuthError("discovery", `discovery document: HTTP ${res.status}`);
  return (await res.json()) as Discovery;
}

export type IdClaims = {
  sub: string;
  email?: string;
  aud: string | string[];
  iss: string;
  exp: number;
  nonce?: string;
};

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

// Checks the ID token's signature against OpenAI's published keys, then issuer, audience,
// expiry and nonce. Returns the claims.
export async function verifyIdToken(
  f: Fetch,
  idToken: string,
  expect: { clientId: string; nonce: string; now?: number },
): Promise<IdClaims> {
  const [h, p, s] = idToken.split(".");
  if (!h || !p || !s) throw new AuthError("id_token", "the ID token is malformed");
  const header = decodePart<{ alg: string; kid?: string }>(h);
  const claims = decodePart<IdClaims>(p);
  if (header.alg !== "RS256") throw new AuthError("id_token", `unexpected ID token algorithm ${header.alg}`);
  const disc = await discovery(f);
  if (!disc.jwks_uri) throw new AuthError("id_token", "the discovery document has no jwks_uri");
  const jwks = (await (await f(disc.jwks_uri)).json()) as { keys: (Record<string, unknown> & { kid?: string })[] };
  const jwk = jwks.keys.find((k) => !header.kid || k.kid === header.kid);
  if (!jwk) throw new AuthError("id_token", "no published key matches the ID token");
  const key = createPublicKey({ key: jwk as JsonWebKeyInput["key"], format: "jwk" });
  const ok = verifySignature("sha256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"));
  if (!ok) throw new AuthError("id_token", "the ID token signature does not verify");
  if (claims.iss !== AUTH_ISSUER) throw new AuthError("id_token", `unexpected issuer ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(expect.clientId)) throw new AuthError("id_token", "the ID token was issued to another client");
  if (claims.exp * 1000 < (expect.now ?? Date.now()) - 60_000) throw new AuthError("id_token", "the ID token expired");
  if (claims.nonce !== expect.nonce) throw new AuthError("id_token", "the ID token nonce does not match");
  return claims;
}

export async function revoke(f: Fetch, clientId: string, refreshToken: string): Promise<void> {
  const disc = await discovery(f);
  if (!disc.revocation_endpoint) throw new AuthError("revoke", "the discovery document has no revocation_endpoint");
  for (let attempt = 0; ; attempt++) {
    const res = await postForm(f, disc.revocation_endpoint, {
      token: refreshToken,
      token_type_hint: "refresh_token",
      client_id: clientId,
    }).catch(() => undefined);
    if (res && res.status < 500) return;
    if (attempt >= 2) throw new AuthError("revoke", "could not reach the revocation endpoint");
    await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  }
}

// Where the sign-in lives: the account (not secret) in ~/.teh/auth, the tokens in a secret store.
export class ChatGPTCredentials {
  private readonly dir: string;
  constructor(
    tehHome: string,
    private readonly secrets: SecretStore = secretStore(tehHome),
    private readonly f: Fetch = fetch,
  ) {
    this.dir = join(tehHome, "auth");
  }

  account(): ChatGPTAccount | undefined {
    try {
      return JSON.parse(readFileSync(join(this.dir, "chatgpt.json"), "utf8")) as ChatGPTAccount;
    } catch {
      return undefined;
    }
  }

  saveAccount(a: ChatGPTAccount): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, "chatgpt.json"), `${JSON.stringify(a, null, 2)}\n`);
  }

  tokens(): ChatGPTTokens | undefined {
    const raw = this.secrets.get(SECRET_ACCOUNT);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as ChatGPTTokens;
    } catch {
      return undefined;
    }
  }

  saveTokens(t: ChatGPTTokens): void {
    this.secrets.set(SECRET_ACCOUNT, JSON.stringify(t));
  }

  clearTokens(): void {
    this.secrets.delete(SECRET_ACCOUNT);
  }

  signedIn(): boolean {
    return this.account()?.planEnabled === true && this.tokens() !== undefined;
  }

  // A valid access token, refreshed shortly before it expires. Refreshes are serialised across
  // processes with a lock directory, since each refresh rotates the refresh token.
  async accessToken(): Promise<string> {
    const account = this.account();
    let tokens = this.tokens();
    if (!account || !tokens) throw new AuthError("signed_out", "not signed in to ChatGPT; run `teh login chatgpt`");
    if (!account.planEnabled)
      throw new AuthError("plan_disabled", "ChatGPT plan usage is not enabled; run `teh login chatgpt` to enable it");
    if (tokens.expiresAt - Date.now() > 120_000) return tokens.accessToken;
    const release = await this.lock();
    try {
      tokens = this.tokens() ?? tokens; // another process may have refreshed meanwhile
      if (tokens.expiresAt - Date.now() > 120_000) return tokens.accessToken;
      try {
        tokens = await refreshTokens(this.f, account.clientId, tokens);
      } catch (e) {
        if (e instanceof AuthError && TERMINAL_REFRESH_ERRORS.has(e.code)) {
          this.clearTokens();
          throw new AuthError(e.code, "the ChatGPT sign-in has expired; run `teh login chatgpt`");
        }
        throw e;
      }
      this.saveTokens(tokens);
      return tokens.accessToken;
    } finally {
      release();
    }
  }

  private async lock(): Promise<() => void> {
    mkdirSync(this.dir, { recursive: true });
    const path = join(this.dir, "chatgpt.lock");
    for (let i = 0; i < 100; i++) {
      try {
        mkdirSync(path);
        return () => rmSync(path, { recursive: true, force: true });
      } catch {
        // A lock older than 30 s belongs to a process that died.
        try {
          if (Date.now() - statSync(path).mtimeMs > 30_000) rmSync(path, { recursive: true, force: true });
        } catch {}
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new AuthError("lock", "another teh process is refreshing the ChatGPT sign-in");
  }
}
