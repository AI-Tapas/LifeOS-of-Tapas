// Token endpoint: exchanges a single-use authorization code for an access
// token, and refreshes an expiring one. Public clients only, so PKCE is the
// proof rather than a client secret.
//
// Codes and tokens are stored as hashes; this endpoint therefore looks a row
// up by hash, checks the rules in lib/mcp/oauth-core.ts, and marks the code
// used in the same breath so a replay finds nothing.

import { createServiceClient } from "@/lib/supabase/service";
import {
  ACCESS_TTL_MS,
  REFRESH_TTL_MS,
  SCOPE,
  checkCodeExchange,
  checkGrantUsable,
  expiryFrom,
  hashSecret,
  newSecret,
} from "@/lib/mcp/oauth-core";

export const runtime = "nodejs";

function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { "cache-control": "no-store" } }
  );
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await req.json()) as Record<string, string>;
    return new URLSearchParams(body);
  }
  return new URLSearchParams(await req.text());
}

export async function POST(req: Request): Promise<Response> {
  let p: URLSearchParams;
  try {
    p = await readParams(req);
  } catch {
    return oauthError("invalid_request", "The request body could not be read.");
  }

  const grantType = p.get("grant_type") ?? "";
  const clientId = p.get("client_id") ?? "";
  const svc = createServiceClient();
  const now = new Date();

  if (grantType === "authorization_code") {
    const code = p.get("code") ?? "";
    const redirectUri = p.get("redirect_uri") ?? "";
    const verifier = p.get("code_verifier") ?? "";
    const { data: grant } = await svc
      .from("mcp_grants")
      .select("*")
      .eq("token_hash", hashSecret(code))
      .maybeSingle();

    const check = checkCodeExchange(grant, { clientId, redirectUri, verifier }, now);
    if (!check.ok) return oauthError("invalid_grant", check.reason);

    // Burn the code first: if anything below fails, it still cannot be reused.
    await svc
      .from("mcp_grants")
      .update({ used_at: now.toISOString() })
      .eq("id", grant!.id);

    return issueTokens(svc, grant!.user_id, clientId, now);
  }

  if (grantType === "refresh_token") {
    const refresh = p.get("refresh_token") ?? "";
    const { data: grant } = await svc
      .from("mcp_grants")
      .select("*")
      .eq("token_hash", hashSecret(refresh))
      .maybeSingle();

    const check = checkGrantUsable(grant, now, "refresh");
    if (!check.ok) return oauthError("invalid_grant", check.reason);
    if (grant!.client_id !== clientId) {
      return oauthError("invalid_grant", "This refresh token belongs to a different client.");
    }
    // Rotate: the old refresh token dies with the new pair, so a stolen copy
    // is useful only until the legitimate client next refreshes.
    await svc
      .from("mcp_grants")
      .update({ revoked_at: now.toISOString() })
      .eq("id", grant!.id);

    return issueTokens(svc, grant!.user_id, clientId, now);
  }

  return oauthError("unsupported_grant_type", `${grantType || "(none)"} is not supported.`);
}

async function issueTokens(
  svc: ReturnType<typeof createServiceClient>,
  userId: string,
  clientId: string,
  now: Date
): Promise<Response> {
  const access = newSecret();
  const refresh = newSecret();
  const { error } = await svc.from("mcp_grants").insert([
    {
      user_id: userId,
      client_id: clientId,
      kind: "access" as const,
      token_hash: hashSecret(access),
      expires_at: expiryFrom(now, ACCESS_TTL_MS),
    },
    {
      user_id: userId,
      client_id: clientId,
      kind: "refresh" as const,
      token_hash: hashSecret(refresh),
      expires_at: expiryFrom(now, REFRESH_TTL_MS),
    },
  ]);
  if (error) return oauthError("server_error", error.message, 500);

  await svc
    .from("mcp_clients")
    .update({ last_used_at: now.toISOString() })
    .eq("client_id", clientId);

  return Response.json(
    {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(ACCESS_TTL_MS / 1000),
      refresh_token: refresh,
      scope: SCOPE,
    },
    { headers: { "cache-control": "no-store" } }
  );
}
