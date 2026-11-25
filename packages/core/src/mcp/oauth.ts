// OAuth sign-in for remote MCP servers (ADR-0025), following the MCP authorization spec:
// protected resource metadata (RFC 9728) names the authorization server, its metadata
// (RFC 8414 or OpenID discovery) gives the endpoints, dynamic client registration (RFC 7591)
// gets a client id, and the code flow uses PKCE S256 and the resource indicator (RFC 8707).
// The browser and the loopback listener live in the CLI; this file is the protocol.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SecretStore, secretStore } from "../auth/secrets";

export type AuthServerMeta = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
  scopes_supported?: string[];
};
export type OAuthClient = { clientId: string; clientSecret?: string; redirectUri: string };
export type McpRegistration = { resource: string; authServer: AuthServerMeta; client: OAuthClient; scope?: string };
export type McpTokens = { accessToken: string; refreshToken?: string; expiresAt?: number; scope?: string };

export class McpAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "McpAuthError";
  }
}

type Fetch = typeof fetch;

// The server URL as the resource indicator: no fragment, scheme and host lower case.
export function canonicalResource(url: string): string {
  const u = new URL(url);
  u.hash = "";
  return u.href;
}

// `Bearer resource_metadata="…", scope="…"` → its parameters.
export function parseChallenge(header: string | undefined): { resourceMetadata?: string; scope?: string } {
  const out: { resourceMetadata?: string; scope?: string } = {};
  for (const m of (header ?? "").matchAll(/([a-zA-Z_]+)="([^"]*)"/g)) {
    if (m[1] === "resource_metadata") out.resourceMetadata = m[2] as string;
    if (m[1] === "scope") out.scope = m[2] as string;
  }
  return out;
}

async function getJson(f: Fetch, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await f(url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(15_000) });
    if (!r.ok) return undefined;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// Where to sign in for `serverUrl`, given the 401's WWW-Authenticate header.
export async function discoverAuth(
  f: Fetch,
  serverUrl: string,
  challenge?: string,
): Promise<{ resource: string; authServer: AuthServerMeta; scope?: string }> {
  const resource = canonicalResource(serverUrl);
  const server = new URL(serverUrl);
  const c = parseChallenge(challenge);
  const path = server.pathname === "/" ? "" : server.pathname;
  const prmUrls = [
    ...(c.resourceMetadata ? [c.resourceMetadata] : []),
    `${server.origin}/.well-known/oauth-protected-resource${path}`,
    `${server.origin}/.well-known/oauth-protected-resource`,
  ];
  let prm: Record<string, unknown> | undefined;
  for (const u of prmUrls) {
    prm = await getJson(f, u);
    if (prm) break;
  }
  if (prm && typeof prm.resource === "string" && new URL(prm.resource).origin !== server.origin)
    throw new McpAuthError("resource_mismatch", `the server's metadata names a different resource (${prm.resource})`);
  // Servers on the 2025-03-26 spec have no resource metadata: the server's origin is the issuer.
  const issuer = (prm?.authorization_servers as string[] | undefined)?.[0] ?? server.origin;
  const is = new URL(issuer);
  const ipath = is.pathname === "/" ? "" : is.pathname.replace(/\/$/, "");
  const metaUrls = ipath
    ? [
        `${is.origin}/.well-known/oauth-authorization-server${ipath}`,
        `${is.origin}/.well-known/openid-configuration${ipath}`,
        `${is.origin}${ipath}/.well-known/openid-configuration`,
      ]
    : [`${is.origin}/.well-known/oauth-authorization-server`, `${is.origin}/.well-known/openid-configuration`];
  let meta: Record<string, unknown> | undefined;
  for (const u of metaUrls) {
    meta = await getJson(f, u);
    if (meta) break;
  }
  if (!meta || typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string")
    throw new McpAuthError("no_metadata", `could not find OAuth metadata for ${issuer}`);
  const methods = meta.code_challenge_methods_supported as string[] | undefined;
  // The spec requires PKCE; a server that does not say it supports S256 is refused.
  if (!methods?.includes("S256"))
    throw new McpAuthError("no_pkce", `${issuer} does not advertise PKCE (S256), which MCP sign-in requires`);
  const scopes = c.scope ?? (prm?.scopes_supported as string[] | undefined)?.join(" ");
  return { resource, authServer: meta as unknown as AuthServerMeta, ...(scopes ? { scope: scopes } : {}) };
}

export async function registerClient(f: Fetch, as: AuthServerMeta, redirectUri: string): Promise<OAuthClient> {
  if (!as.registration_endpoint)
    throw new McpAuthError(
      "no_registration",
      `${as.issuer} does not offer client registration; add "oauth": {"clientId": "…"} to the server's config`,
    );
  const r = await f(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "The Everything Harness (teh)",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const body = (await r.json().catch(() => ({}))) as { client_id?: string; client_secret?: string; error?: string };
  if (!r.ok || !body.client_id)
    throw new McpAuthError("registration_failed", `client registration failed: ${body.error ?? `HTTP ${r.status}`}`);
  return { clientId: body.client_id, ...(body.client_secret ? { clientSecret: body.client_secret } : {}), redirectUri };
}

export function buildAuthorizeUrl(p: { reg: McpRegistration; state: string; challenge: string }): string {
  const u = new URL(p.reg.authServer.authorization_endpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", p.reg.client.clientId);
  u.searchParams.set("redirect_uri", p.reg.client.redirectUri);
  u.searchParams.set("state", p.state);
  u.searchParams.set("code_challenge", p.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("resource", p.reg.resource);
  if (p.reg.scope) u.searchParams.set("scope", p.reg.scope);
  return u.href;
}

async function tokenRequest(f: Fetch, reg: McpRegistration, form: Record<string, string>): Promise<McpTokens> {
  const body = new URLSearchParams({ ...form, client_id: reg.client.clientId, resource: reg.resource });
  if (reg.client.clientSecret) body.set("client_secret", reg.client.clientSecret);
  const r = await f(reg.authServer.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  const j = (await r.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  if (!r.ok || !j.access_token)
    throw new McpAuthError(j.error ?? "token_failed", j.error_description ?? j.error ?? `HTTP ${r.status}`);
  return {
    accessToken: j.access_token,
    ...(j.refresh_token ? { refreshToken: j.refresh_token } : {}),
    ...(j.expires_in ? { expiresAt: Date.now() + j.expires_in * 1000 } : {}),
    ...(j.scope ? { scope: j.scope } : {}),
  };
}

export const exchangeMcpCode = (f: Fetch, reg: McpRegistration, code: string, verifier: string) =>
  tokenRequest(f, reg, {
    grant_type: "authorization_code",
    code,
    code_verifier: verifier,
    redirect_uri: reg.client.redirectUri,
  });

export async function refreshMcpTokens(f: Fetch, reg: McpRegistration, tokens: McpTokens): Promise<McpTokens> {
  if (!tokens.refreshToken) throw new McpAuthError("no_refresh_token", "the sign-in has expired");
  const next = await tokenRequest(f, reg, { grant_type: "refresh_token", refresh_token: tokens.refreshToken });
  // Servers that do not rotate refresh tokens leave the old one valid.
  return { ...next, ...(next.refreshToken ? {} : { refreshToken: tokens.refreshToken }) };
}

// Saved sign-ins, one per server URL: the registration in ~/.teh/auth/mcp/, tokens in the
// OS secret store.
export class McpCredentials {
  private readonly dir: string;
  private readonly secrets: SecretStore;

  constructor(
    tehHome: string,
    secrets?: SecretStore,
    private readonly f: Fetch = fetch,
  ) {
    this.dir = join(tehHome, "auth", "mcp");
    this.secrets = secrets ?? secretStore(tehHome);
  }

  private key(url: string) {
    return createHash("sha256").update(canonicalResource(url)).digest("hex").slice(0, 16);
  }

  registration(url: string): McpRegistration | undefined {
    const p = join(this.dir, `${this.key(url)}.json`);
    if (!existsSync(p)) return undefined;
    try {
      return JSON.parse(readFileSync(p, "utf8")) as McpRegistration;
    } catch {
      return undefined;
    }
  }

  saveRegistration(url: string, reg: McpRegistration) {
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(this.dir, `${this.key(url)}.json`), `${JSON.stringify(reg, null, 2)}\n`, { mode: 0o600 });
  }

  tokens(url: string): McpTokens | undefined {
    const raw = this.secrets.get(`mcp:${this.key(url)}`);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as McpTokens;
    } catch {
      return undefined;
    }
  }

  saveTokens(url: string, t: McpTokens) {
    this.secrets.set(`mcp:${this.key(url)}`, JSON.stringify(t));
  }

  forget(url: string) {
    this.secrets.delete(`mcp:${this.key(url)}`);
    rmSync(join(this.dir, `${this.key(url)}.json`), { force: true });
  }

  // A valid access token, refreshed a minute before it expires; undefined when not signed in.
  async accessToken(url: string): Promise<string | undefined> {
    const reg = this.registration(url);
    const t = this.tokens(url);
    if (!reg || !t) return undefined;
    if (!t.expiresAt || t.expiresAt - Date.now() > 60_000) return t.accessToken;
    try {
      const next = await refreshMcpTokens(this.f, reg, t);
      this.saveTokens(url, next);
      return next.accessToken;
    } catch (e) {
      // A refused refresh means signing in again; a network error keeps the old token to try.
      if (e instanceof McpAuthError) this.secrets.delete(`mcp:${this.key(url)}`);
      return e instanceof McpAuthError ? undefined : t.accessToken;
    }
  }
}
