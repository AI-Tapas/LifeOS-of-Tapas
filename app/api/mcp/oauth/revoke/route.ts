// Token revocation (RFC 7009). A client that signs out should be able to
// throw its own credentials away; the owner can also revoke a whole
// connection from Settings, which is the stronger control.
//
// Per the specification this always answers 200, even for an unknown token:
// a probe must not learn whether a token was ever valid.

import { createServiceClient } from "@/lib/supabase/service";
import { hashSecret } from "@/lib/mcp/oauth-core";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let params: URLSearchParams;
  try {
    const type = req.headers.get("content-type") ?? "";
    params = type.includes("application/json")
      ? new URLSearchParams((await req.json()) as Record<string, string>)
      : new URLSearchParams(await req.text());
  } catch {
    return new Response(null, { status: 200 });
  }

  const token = params.get("token") ?? "";
  if (token) {
    const svc = createServiceClient();
    await svc
      .from("mcp_grants")
      .update({ revoked_at: new Date().toISOString() })
      .eq("token_hash", hashSecret(token))
      .is("revoked_at", null);
  }
  return new Response(null, { status: 200, headers: { "cache-control": "no-store" } });
}
