// Authorization endpoint. This is the step that proves the caller is Tapas:
// it requires a live Supabase session in the browser, and then a deliberate
// press on the consent screen. No session means a redirect to sign in first,
// returning here afterwards.
//
// Errors that concern the client (bad redirect URI, unknown client) are shown
// on our own page rather than redirected, since an attacker-supplied redirect
// must never be trusted enough to bounce back to.

import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { redirectUriAllowed, SCOPE } from "@/lib/mcp/oauth-core";

export const runtime = "nodejs";

function problem(message: string): Response {
  return new Response(
    `Life OS could not start this connection.\n\n${message}\n\n` +
      `Nothing has been granted. You can close this window.`,
    { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } }
  );
}

export async function GET(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const p = url.searchParams;
  const clientId = p.get("client_id") ?? "";
  const redirectUri = p.get("redirect_uri") ?? "";
  const state = p.get("state") ?? "";
  const challenge = p.get("code_challenge") ?? "";
  const method = p.get("code_challenge_method") ?? "";
  const responseType = p.get("response_type") ?? "";

  if (responseType !== "code") {
    return problem("Only the authorization code flow is supported.");
  }
  if (!challenge || method !== "S256") {
    return problem("This connection must use PKCE with the S256 method.");
  }

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("mcp_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (!client) return problem("That client is not registered with Life OS.");
  if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
    return problem("That redirect address was not registered by this client.");
  }

  // Identity check: only a signed-in owner may see the consent screen.
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    const back = `${url.pathname}${url.search}`;
    redirect(`/login?next=${encodeURIComponent(back)}`);
  }

  // Hand off to the consent page, carrying the request as it was validated.
  const consent = new URL("/connect", url.origin);
  consent.searchParams.set("client_id", clientId);
  consent.searchParams.set("redirect_uri", redirectUri);
  consent.searchParams.set("state", state);
  consent.searchParams.set("code_challenge", challenge);
  consent.searchParams.set("scope", p.get("scope") || SCOPE);
  redirect(consent.toString());
}
