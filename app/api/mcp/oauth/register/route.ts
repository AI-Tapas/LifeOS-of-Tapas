// Public dynamic registration grants no data access. Validation and a database
// quota bound persistent writes across all application instances.
import { createServiceClient } from "@/lib/supabase/service";
import { serviceActor } from "@/lib/assistant/actor";
import { newSecret, registrationMetadata } from "@/lib/mcp/oauth-core";
import { readBoundedText, rpcErrorCode, rpcSucceeded } from "@/lib/mcp/oauth-http";
export const runtime = "nodejs";
export async function POST(req: Request): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(await readBoundedText(req)); }
  catch { return Response.json({ error: "invalid_client_metadata", error_description: "Body must be a JSON object under 16 KiB." }, { status: 400 }); }
  const metadata = registrationMetadata(body);
  if (!metadata) return Response.json({ error: "invalid_client_metadata", error_description: "Use a name of 1 to 120 characters and 1 to 10 HTTPS or localhost redirect URIs, without credentials or fragments. Only public PKCE clients are supported." }, { status: 400 });
  const clientId = `lifeos_${newSecret(16)}`;
  try {
    const { userId } = await serviceActor();
    const { data, error } = await createServiceClient().rpc("oauth_register_client", {
      p_user_id: userId, p_client_id: clientId, p_client_name: metadata.client_name, p_redirect_uris: metadata.redirect_uris,
    });
    if (rpcErrorCode(data) === "rate_limited") return Response.json({ error: "temporarily_unavailable", error_description: "Registration limit reached. Try again in an hour." }, { status: 429, headers: { "retry-after": "3600", "cache-control": "no-store" } });
    if (error || !rpcSucceeded(data)) throw new Error("Registration failed");
  } catch {
    return Response.json({ error: "server_error", error_description: "Registration is temporarily unavailable." }, { status: 503, headers: { "cache-control": "no-store" } });
  }
  return Response.json({ client_id: clientId, ...metadata, token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }, { status: 201, headers: { "cache-control": "no-store" } });
}
