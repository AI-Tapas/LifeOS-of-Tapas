// Consume a code or rotate a refresh family in one database transaction.
// Client locking serializes exchanges with owner disconnect and re-consent.
import { createHash } from "node:crypto";
import { createServiceClient } from "@/lib/supabase/service";
import { ACCESS_TTL_MS, SCOPE, hashSecret, newSecret } from "@/lib/mcp/oauth-core";
import { readOAuthParams, rpcSucceeded } from "@/lib/mcp/oauth-http";

export const runtime = "nodejs";
function oauthError(error: string, description: string, status = 400): Response {
  return Response.json({ error, error_description: description }, { status, headers: { "cache-control": "no-store" } });
}
export async function POST(req: Request): Promise<Response> {
  let p: URLSearchParams;
  try { p = await readOAuthParams(req); }
  catch { return oauthError("invalid_request", "The request must contain valid, bounded OAuth parameters."); }
  const grantType = p.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") return oauthError("unsupported_grant_type", "This grant type is not supported.");
  const clientId = p.get("client_id") ?? "";
  const secret = p.get(grantType === "authorization_code" ? "code" : "refresh_token") ?? "";
  const verifier = p.get("code_verifier") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  if (!clientId || clientId.length > 200 || !secret || secret.length > 1024) return oauthError("invalid_request", "A client and credential are required.");
  if (grantType === "authorization_code" && (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !redirectUri || redirectUri.length > 2048)) return oauthError("invalid_grant", "The authorization proof is invalid.");
  const access = newSecret();
  const refresh = newSecret();
  try {
    const { data, error } = await createServiceClient().rpc("oauth_exchange_grant", {
      p_client_id: clientId, p_kind: grantType === "authorization_code" ? "code" : "refresh",
      p_token_hash: hashSecret(secret), p_redirect_uri: redirectUri,
      p_code_challenge: grantType === "authorization_code" ? createHash("sha256").update(verifier).digest("base64url") : "",
      p_access_hash: hashSecret(access), p_refresh_hash: hashSecret(refresh),
    });
    if (error) return oauthError("server_error", "Credentials could not be issued. Start the connection again if the outcome is uncertain.", 503);
    if (!rpcSucceeded(data)) return oauthError("invalid_grant", "This credential is invalid, expired, used or disconnected. Reconnect to review permissions.");
  } catch {
    return oauthError("server_error", "The authorization service is unavailable.", 503);
  }
  return Response.json({ access_token: access, token_type: "Bearer", expires_in: Math.floor(ACCESS_TTL_MS / 1000), refresh_token: refresh, scope: SCOPE }, { headers: { "cache-control": "no-store" } });
}
