// OAuth 2.1 primitives for the remote MCP connector, kept pure so
// scripts/m4.test.ts can prove them offline: PKCE verification, secret
// hashing, redirect-URI matching and the grant lifecycle rules.
//
// The rules enforced here are the ones that matter if a code or token leaks:
//   * an authorization code is single use, short lived, and bound to both the
//     client that asked for it and the exact redirect URI,
//   * PKCE S256 is mandatory, so a stolen code is useless without the
//     verifier that never left the client,
//   * secrets are compared as sha256 hashes, never in the clear.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes, per OAuth 2.1 guidance
export const ACCESS_TTL_MS = 60 * 60 * 1000; // 1 hour
export const REFRESH_TTL_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
export const SCOPE = "lifeos";

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

export function secretMatchesHash(secret: string, hash: string): boolean {
  const a = Buffer.from(hashSecret(secret));
  const b = Buffer.from(hash);
  return a.length === b.length && timingSafeEqual(a, b);
}

// PKCE S256: BASE64URL(SHA256(verifier)) must equal the stored challenge.
export function verifyPkce(
  verifier: string,
  challenge: string,
  method = "S256"
): { ok: true } | { ok: false; reason: string } {
  if (method !== "S256") {
    return { ok: false, reason: "Only the S256 code challenge method is supported." };
  }
  if (verifier.length < 43 || verifier.length > 128) {
    return { ok: false, reason: "The code verifier must be 43 to 128 characters." };
  }
  const computed = createHash("sha256").update(verifier, "utf8").digest("base64url");
  const a = Buffer.from(computed);
  const b = Buffer.from(challenge);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return ok ? { ok: true } : { ok: false, reason: "The code verifier does not match." };
}

// Redirect URIs must match exactly, one of the registered set. Anything looser
// (prefix or host matching) is how authorization codes get stolen.
export function redirectUriAllowed(uri: string, registered: string[]): boolean {
  return registered.includes(uri);
}

// A redirect target must be https, or localhost for a desktop client's loopback
// listener. Anything else is refused at registration time.
export function isAcceptableRedirectUri(uri: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") return true;
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
  return parsed.protocol === "http:" && loopback;
}

export interface GrantRow {
  kind: "code" | "access" | "refresh";
  client_id: string;
  redirect_uri: string | null;
  code_challenge: string | null;
  expires_at: string;
  used_at: string | null;
  revoked_at: string | null;
}

export type GrantCheck = { ok: true } | { ok: false; reason: string };

export function checkGrantUsable(
  grant: GrantRow | null,
  now: Date,
  expectKind: GrantRow["kind"]
): GrantCheck {
  if (!grant) return { ok: false, reason: "Unknown or already used credential." };
  if (grant.kind !== expectKind) {
    return { ok: false, reason: `Expected a ${expectKind} credential.` };
  }
  if (grant.revoked_at) return { ok: false, reason: "This credential was revoked." };
  if (grant.used_at && expectKind === "code") {
    // Replay of a code: the legitimate exchange already happened.
    return { ok: false, reason: "This authorization code was already used." };
  }
  if (new Date(grant.expires_at).getTime() <= now.getTime()) {
    return { ok: false, reason: "This credential has expired." };
  }
  return { ok: true };
}

// Everything the token endpoint must agree on before a code becomes a token.
export function checkCodeExchange(
  grant: GrantRow | null,
  params: { clientId: string; redirectUri: string; verifier: string },
  now: Date
): GrantCheck {
  const usable = checkGrantUsable(grant, now, "code");
  if (!usable.ok) return usable;
  const g = grant!;
  if (g.client_id !== params.clientId) {
    return { ok: false, reason: "This code belongs to a different client." };
  }
  if (g.redirect_uri !== params.redirectUri) {
    return { ok: false, reason: "The redirect URI does not match the one used to authorize." };
  }
  if (!g.code_challenge) {
    return { ok: false, reason: "This code was issued without PKCE and cannot be exchanged." };
  }
  const pkce = verifyPkce(params.verifier, g.code_challenge);
  return pkce.ok ? { ok: true } : { ok: false, reason: pkce.reason };
}

export function expiryFrom(now: Date, ttlMs: number): string {
  return new Date(now.getTime() + ttlMs).toISOString();
}

// Discovery documents. Kept here so the shape is testable without a server.
export function authorizationServerMetadata(origin: string): Record<string, unknown> {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/mcp/oauth/authorize`,
    token_endpoint: `${origin}/api/mcp/oauth/token`,
    registration_endpoint: `${origin}/api/mcp/oauth/register`,
    revocation_endpoint: `${origin}/api/mcp/oauth/revoke`,
    scopes_supported: [SCOPE],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}

export function protectedResourceMetadata(origin: string): Record<string, unknown> {
  return {
    resource: `${origin}/api/mcp/http`,
    authorization_servers: [origin],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
  };
}
