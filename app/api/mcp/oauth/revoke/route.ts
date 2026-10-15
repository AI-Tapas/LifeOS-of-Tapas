// RFC 7009: unknown credentials still receive 200; infrastructure failure does
// not pretend revocation succeeded. Refresh revocation also kills descendants.
import { createServiceClient } from "@/lib/supabase/service";
import { hashSecret } from "@/lib/mcp/oauth-core";
import { readOAuthParams, rpcSucceeded } from "@/lib/mcp/oauth-http";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  const headers = { "cache-control": "no-store" };
  let params: URLSearchParams;
  try { params = await readOAuthParams(req); }
  catch { return Response.json({ error: "invalid_request" }, { status: 400, headers }); }
  const token = params.get("token") ?? "";
  if (!token) return new Response(null, { status: 200, headers });
  if (token.length > 1024 || (params.get("client_id") ?? "").length > 200) return Response.json({ error: "invalid_request" }, { status: 400, headers });
  try {
    const { data, error } = await createServiceClient().rpc("oauth_revoke_token", { p_client_id: params.get("client_id") ?? "", p_token_hash: hashSecret(token) });
    if (error || !rpcSucceeded(data)) throw new Error("Revocation failed");
  } catch { return Response.json({ error: "temporarily_unavailable" }, { status: 503, headers }); }
  return new Response(null, { status: 200, headers });
}
