// Dynamic client registration (RFC 7591). MCP clients such as ChatGPT and
// Claude register themselves before the first authorization.
//
// Registration is open, which is the norm for this flow, and safe here because
// registering grants nothing: a client still cannot reach any data until the
// owner signs in and presses Approve on the consent screen. Only public
// clients with PKCE are issued, so there is no client secret to leak.

import { createServiceClient } from "@/lib/supabase/service";
import { serviceActor } from "@/lib/assistant/actor";
import { newSecret, isAcceptableRedirectUri } from "@/lib/mcp/oauth-core";

export const runtime = "nodejs";

export async function POST(req: Request): Promise<Response> {
  let body: { client_name?: string; redirect_uris?: string[] };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json(
      { error: "invalid_client_metadata", error_description: "Body must be JSON." },
      { status: 400 }
    );
  }

  const uris = (body.redirect_uris ?? []).filter((u) => typeof u === "string");
  if (!uris.length) {
    return Response.json(
      { error: "invalid_redirect_uri", error_description: "At least one redirect_uri is required." },
      { status: 400 }
    );
  }
  const bad = uris.find((u) => !isAcceptableRedirectUri(u));
  if (bad) {
    return Response.json(
      {
        error: "invalid_redirect_uri",
        error_description: `${bad} must be https, or http on localhost.`,
      },
      { status: 400 }
    );
  }

  const clientId = `lifeos_${newSecret(16)}`;
  const { userId } = await serviceActor();
  const svc = createServiceClient();
  const { error } = await svc.from("mcp_clients").insert({
    user_id: userId,
    client_id: clientId,
    client_name: (body.client_name ?? "MCP client").slice(0, 120),
    redirect_uris: uris,
  });
  if (error) {
    return Response.json(
      { error: "server_error", error_description: error.message },
      { status: 500 }
    );
  }

  return Response.json(
    {
      client_id: clientId,
      client_name: body.client_name ?? "MCP client",
      redirect_uris: uris,
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
    },
    { status: 201 }
  );
}
