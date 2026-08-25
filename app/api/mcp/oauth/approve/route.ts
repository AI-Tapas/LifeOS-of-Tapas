// Approving a connection: a plain form POST, not a client-side action.
//
// The consent screen used to hand this to a React server action, which meant
// approval depended on the page hydrating. When that failed the owner got an
// opaque error page and no grant was ever created. A form post has no such
// dependency: it works with JavaScript broken, and the browser follows the
// redirect back to the client itself.
//
// Guards, in order: the request must come from our own origin (a cross-site
// form must not be able to mint a grant off the owner's live session), a
// signed-in owner, a registered client, and a redirect address that client
// registered. Only then does a code exist.

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { appOrigin, requestOrigin } from "@/lib/mcp/origin";
import {
  CODE_TTL_MS,
  expiryFrom,
  hashSecret,
  newSecret,
  redirectUriAllowed,
} from "@/lib/mcp/oauth-core";

export const runtime = "nodejs";

function refuse(message: string, status = 400): Response {
  return new Response(
    `<!doctype html><meta charset="utf-8"><title>Connection refused</title>` +
      `<body style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.25rem">Connection refused</h1>` +
      `<p>${message}</p><p>Nothing has been granted. You can close this window.</p>` +
      `<p><a href="/">Back to Life OS</a></p></body>`,
    { status, headers: { "content-type": "text/html; charset=utf-8" } }
  );
}

export async function POST(req: Request): Promise<Response> {
  // Cross-site request forgery guard: only our own pages may submit this.
  // Both the configured base URL and the host actually served are accepted,
  // since the app is legitimately reachable on more than one (localhost, a
  // Vercel preview domain) and a mismatch there is not an attack.
  const origin = req.headers.get("origin");
  const allowed = [appOrigin(req), requestOrigin(req)].filter(Boolean);
  if (origin && !allowed.includes(origin)) {
    return refuse("That request did not come from Life OS.", 403);
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return refuse("The approval form could not be read.");
  }
  const clientId = String(form.get("client_id") ?? "");
  const redirectUri = String(form.get("redirect_uri") ?? "");
  const state = String(form.get("state") ?? "");
  const codeChallenge = String(form.get("code_challenge") ?? "");

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return refuse("Your session has expired. Sign in and start again.", 401);
  if (!codeChallenge) return refuse("This request is missing its security challenge.");

  const svc = createServiceClient();
  const { data: client, error: clientError } = await svc
    .from("mcp_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", clientId)
    .maybeSingle();
  if (clientError) return refuse(`Could not read the client: ${clientError.message}`, 500);
  if (!client) return refuse("That application is not registered with Life OS.");
  if (!redirectUriAllowed(redirectUri, client.redirect_uris)) {
    return refuse("That return address is not registered by this application.");
  }

  const code = newSecret();
  const { error: grantError } = await svc.from("mcp_grants").insert({
    user_id: user.id,
    client_id: clientId,
    kind: "code",
    token_hash: hashSecret(code),
    code_challenge: codeChallenge,
    redirect_uri: redirectUri,
    expires_at: expiryFrom(new Date(), CODE_TTL_MS),
  });
  if (grantError) {
    return refuse(`Could not record the approval: ${grantError.message}`, 500);
  }

  await svc.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "mcp_connection_approved",
    entity: "mcp_clients",
    meta: { client_id: clientId, client_name: client.client_name },
  });

  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  if (state) back.searchParams.set("state", state);
  // 303 so the browser follows with GET, as the client expects.
  return Response.redirect(back.toString(), 303);
}
