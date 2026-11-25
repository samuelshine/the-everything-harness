// Test helpers for Sign in with ChatGPT: a signing key and a fake auth.openai.com.
import { generateKeyPairSync, sign } from "node:crypto";
import { AUTH_ISSUER } from "../src";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256", use: "sig" };

export function idToken(claims: Record<string, unknown>, key = privateKey): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const head = enc({ alg: "RS256", kid: "k1", typ: "JWT" });
  const body = enc(claims);
  const sig = sign("sha256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

// A stand-in for auth.openai.com: discovery, keys, token and revocation endpoints.
export function fakeAuthServer(opts: { refresh?: (form: URLSearchParams) => Response } = {}) {
  const calls: { url: string; form?: URLSearchParams }[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const form = init?.body ? new URLSearchParams(String(init.body)) : undefined;
    calls.push({ url, ...(form ? { form } : {}) });
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer: AUTH_ISSUER,
        jwks_uri: `${AUTH_ISSUER}/jwks`,
        revocation_endpoint: `${AUTH_ISSUER}/revoke`,
      });
    if (url.endsWith("/jwks")) return Response.json({ keys: [jwk] });
    if (url.endsWith("/revoke")) return new Response("", { status: 200 });
    if (url.endsWith("/oauth/token")) {
      if (form?.get("grant_type") === "refresh_token" && opts.refresh) return opts.refresh(form);
      return Response.json({
        access_token: `access-${calls.length}`,
        refresh_token: `refresh-${calls.length}`,
        id_token: idToken({
          iss: AUTH_ISSUER,
          aud: form?.get("client_id"),
          sub: "user-1",
          email: "a@example.com",
          exp: Math.floor(Date.now() / 1000) + 3600,
          nonce: "N",
        }),
        expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}
