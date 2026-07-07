// Pure OAuth primitives: PKCE, base64url, id_token decode, token-response
// normalisation and revocation detection. Zero imports on purpose so the unit
// test (scripts/oauth.test.ts) can load this file directly under `node --test`
// and so it runs unchanged in Node, the Next server and the edge runtime.

export class TokenRevokedError extends Error {
  constructor(message = "token revoked") {
    super(message);
    this.name = "TokenRevokedError";
  }
}

export class TokenRefreshError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenRefreshError";
  }
}

export interface NormalizedToken {
  accessToken: string;
  // Google usually omits this on refresh (keep the stored one); Microsoft
  // rotates it on every refresh, so a non-null value must always be persisted.
  refreshToken: string | null;
  expiresAt: string; // ISO 8601
  scope: string | null;
  idToken: string | null;
}

// base64url-encode raw bytes without padding.
export function base64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// A URL-safe random string, used for both the PKCE verifier and the state.
export function randomUrlSafe(bytes = 32): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

// PKCE S256 challenge for a given verifier.
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier)
  );
  return base64url(digest);
}

// Decode a JWT payload without verifying the signature. Only used on tokens
// received directly from the provider's token endpoint over TLS, to read the
// account email; never used to make a trust decision.
export function decodeJwtPayload(jwt: string): Record<string, unknown> {
  const part = jwt.split(".")[1];
  if (!part) throw new Error("malformed jwt");
  let b64 = part.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return JSON.parse(atob(b64));
}

// Whether a cached access token is at or past its expiry (with a safety skew).
export function isExpired(
  expiresAt: string | null | undefined,
  skewSeconds = 60,
  nowMs = Date.now()
): boolean {
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() - skewSeconds * 1000 <= nowMs;
}

// OAuth2 error codes that mean the grant is gone and the user must re-consent.
// `invalid_grant` is what both Google and Microsoft return when a refresh token
// is revoked (this fires on the ca.tapasnr password change we design around).
const REVOKED_ERRORS = new Set([
  "invalid_grant",
  "interaction_required",
  "consent_required",
]);

interface TokenBody {
  error?: string;
  error_description?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number | string;
  scope?: string;
  id_token?: string;
}

// Normalise a token endpoint response, or throw a typed error. Kept pure so the
// test can feed mocked Google/Microsoft bodies (including invalid_grant).
export function parseTokenResponse(
  status: number,
  body: TokenBody,
  nowMs = Date.now()
): NormalizedToken {
  if (status !== 200 || body.error || !body.access_token) {
    const err = body.error ?? `http_${status}`;
    const desc = body.error_description ?? "";
    if (REVOKED_ERRORS.has(err)) {
      throw new TokenRevokedError(desc || err);
    }
    throw new TokenRefreshError(desc ? `${err}: ${desc}` : err);
  }
  const expiresIn = Number(body.expires_in ?? 3600);
  return {
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? null,
    expiresAt: new Date(nowMs + expiresIn * 1000).toISOString(),
    scope: body.scope ?? null,
    idToken: body.id_token ?? null,
  };
}
