// Pure-logic proof for the OAuth token layer. No network, no DB: the provider
// HTTP layer is driven with a mocked fetch so refresh success (Google keeps its
// refresh token, Microsoft rolls a new one) and revocation (invalid_grant) are
// all exercised. Run: npm run test:oauth  (needs Node 24+ for .ts stripping).
import test from "node:test";
import assert from "node:assert/strict";
import {
  base64url,
  pkceChallenge,
  decodeJwtPayload,
  isExpired,
  parseTokenResponse,
  TokenRevokedError,
  TokenRefreshError,
} from "../lib/oauth/core.ts";
import {
  buildAuthUrl,
  refreshAccessToken,
  type ClientConfig,
} from "../lib/oauth/providers.ts";

test("PKCE S256 matches the RFC 7636 test vector", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const challenge = await pkceChallenge(verifier);
  assert.equal(challenge, "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
});

test("base64url encodes without padding or unsafe chars", () => {
  const out = base64url(new Uint8Array([251, 255, 191]));
  assert.equal(out, "-_-_");
});

test("decodeJwtPayload reads claims without verifying", () => {
  const payload = { email: "ca.tapasnr@gmail.com" };
  const b64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const jwt = `h.${b64}.sig`;
  assert.equal(decodeJwtPayload(jwt).email, "ca.tapasnr@gmail.com");
});

test("isExpired honours expiry and skew", () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  assert.equal(isExpired(null, 60, now), true);
  assert.equal(isExpired("2026-07-06T11:59:00Z", 60, now), true); // past
  assert.equal(isExpired("2026-07-06T12:00:30Z", 60, now), true); // within skew
  assert.equal(isExpired("2026-07-06T13:00:00Z", 60, now), false); // valid
});

test("parseTokenResponse normalises a Google refresh (no new refresh token)", () => {
  const now = Date.parse("2026-07-06T12:00:00Z");
  const t = parseTokenResponse(
    200,
    { access_token: "ya29.x", expires_in: 3600, scope: "a b" },
    now
  );
  assert.equal(t.accessToken, "ya29.x");
  assert.equal(t.refreshToken, null);
  assert.equal(t.expiresAt, "2026-07-06T13:00:00.000Z");
  assert.equal(t.scope, "a b");
});

test("parseTokenResponse keeps a rolled Microsoft refresh token", () => {
  const t = parseTokenResponse(200, {
    access_token: "eyJ0.x",
    refresh_token: "M.rolled",
    expires_in: 3599,
  });
  assert.equal(t.refreshToken, "M.rolled");
});

test("parseTokenResponse throws TokenRevokedError on invalid_grant", () => {
  assert.throws(
    () => parseTokenResponse(400, { error: "invalid_grant", error_description: "revoked" }),
    TokenRevokedError
  );
});

test("parseTokenResponse throws TokenRefreshError on other failures", () => {
  assert.throws(
    () => parseTokenResponse(400, { error: "invalid_request" }),
    TokenRefreshError
  );
  assert.throws(() => parseTokenResponse(200, {}), TokenRefreshError); // no access_token
});

const CFG: ClientConfig = {
  provider: "google",
  authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
  tokenUrl: "https://oauth2.googleapis.com/token",
  clientId: "cid",
  clientSecret: "secret",
  redirectUri: "https://app.example/api/oauth/google/callback",
  scopes: ["openid", "email"],
};

function mockFetch(status: number, body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

test("buildAuthUrl carries PKCE, state and Google offline consent", () => {
  const url = new URL(
    buildAuthUrl(CFG, { state: "st", codeChallenge: "ch", loginHint: "x@y.z" })
  );
  const q = url.searchParams;
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("state"), "st");
  assert.equal(q.get("access_type"), "offline");
  assert.equal(q.get("prompt"), "consent");
  assert.equal(q.get("login_hint"), "x@y.z");
});

test("refreshAccessToken returns a fresh token from a mocked provider", async () => {
  const t = await refreshAccessToken(
    CFG,
    "stored-refresh",
    mockFetch(200, { access_token: "fresh", expires_in: 3600 })
  );
  assert.equal(t.accessToken, "fresh");
});

test("refreshAccessToken surfaces revocation from a mocked provider", async () => {
  await assert.rejects(
    refreshAccessToken(CFG, "dead-refresh", mockFetch(400, { error: "invalid_grant" })),
    TokenRevokedError
  );
});
