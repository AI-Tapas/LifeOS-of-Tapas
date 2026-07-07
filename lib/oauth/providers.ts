// Relative import (with extension) so scripts/oauth.test.ts can load this file
// directly under `node --test` type-stripping; the type-only import is erased.
import { parseTokenResponse, type NormalizedToken } from "./core.ts";
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
