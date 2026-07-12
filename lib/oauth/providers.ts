// Relative import (with extension) so scripts/oauth.test.ts can load this file
// directly under `node --test` type-stripping; the type-only import is erased.
import {
  parseTokenResponse,
  TokenRevokedError,
  type NormalizedToken,
} from "./core.ts";
import type { Provider } from "@/lib/accounts";

// Fully-resolved config for one OAuth client (built from env in config.ts).
export interface ClientConfig {
  provider: Provider;
  authUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  scopes: string[];
}

type Fetch = typeof fetch;

// Build the provider authorization URL. Google gets access_type=offline and
// prompt=consent to guarantee a refresh token; both providers get PKCE S256
// and state.
export function buildAuthUrl(
  cfg: ClientConfig,
  opts: { state: string; codeChallenge: string; loginHint?: string }
): string {
  const p = new URLSearchParams({
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    response_type: "code",
    scope: cfg.scopes.join(" "),
    state: opts.state,
    code_challenge: opts.codeChallenge,
    code_challenge_method: "S256",
  });
  if (cfg.provider === "google") {
    p.set("access_type", "offline");
    p.set("prompt", "consent");
    p.set("include_granted_scopes", "true");
  } else {
    p.set("response_mode", "query");
    p.set("prompt", "consent");
  }
  if (opts.loginHint) p.set("login_hint", opts.loginHint);
  return `${cfg.authUrl}?${p.toString()}`;
}

async function tokenRequest(
  cfg: ClientConfig,
  params: Record<string, string>,
  fetchImpl: Fetch
): Promise<NormalizedToken> {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: new URLSearchParams({
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      ...params,
    }).toString(),
  });
  let body: unknown = {};
  try {
    body = await res.json();
  } catch {
    // fall through: parseTokenResponse turns a non-200 empty body into an error
  }
  return parseTokenResponse(res.status, body as Record<string, unknown>);
}

export function exchangeCode(
  cfg: ClientConfig,
  code: string,
  codeVerifier: string,
  fetchImpl: Fetch = fetch
): Promise<NormalizedToken> {
  return tokenRequest(
    cfg,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: cfg.redirectUri,
      code_verifier: codeVerifier,
    },
    fetchImpl
  );
}

export function refreshAccessToken(
  cfg: ClientConfig,
  refreshToken: string,
  fetchImpl: Fetch = fetch
): Promise<NormalizedToken> {
  return tokenRequest(
    cfg,
    { grant_type: "refresh_token", refresh_token: refreshToken },
    fetchImpl
  );
}

// Deps for resourceWithReauth, injected so the orchestration is unit-tested
// offline. The DB-wired implementation is lib/oauth/tokens.ts withResourceAuth.
export interface ResourceAuthDeps {
  getToken: () => Promise<string>; // cached-or-refreshed token (fast path)
  forceRefresh: () => Promise<string>; // unconditional refresh; may throw TokenRevokedError
  request: (accessToken: string) => Promise<Response>; // the resource API call
  onDead: () => Promise<void>; // flip needs_reauth when 401 persists after refresh
}

// Run a resource API request with 401-driven reauth recovery. A provider-side
// revocation invalidates the access token immediately, before its expiry clock,
// so the cached token can 401 while still looking valid. On a 401 we force one
// refresh and retry once. If the refresh is revoked (forceRefresh throws
// TokenRevokedError) or the retry still 401s, the account is flipped to
// needs_reauth and TokenRevokedError is thrown for the caller to turn into the
// reauth banner (never a raw 500). Pure orchestration: no DB or network of its
// own.
export async function resourceWithReauth(deps: ResourceAuthDeps): Promise<Response> {
  let res = await deps.request(await deps.getToken());
  if (res.status !== 401) return res;

  const fresh = await deps.forceRefresh();
  res = await deps.request(fresh);
  if (res.status === 401) {
    await deps.onDead();
    throw new TokenRevokedError(
      "resource returned 401 after a forced token refresh"
    );
  }
  return res;
}
