// Plain form POST keeps consent usable without hydration. Permissions, code
// creation and disclosure audit commit together under the same client lock.
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { appOrigin, requestOrigin } from "@/lib/mcp/origin";
import { hashSecret, newSecret } from "@/lib/mcp/oauth-core";
import { readOAuthParams, rpcSucceeded } from "@/lib/mcp/oauth-http";
import { CAPABILITY_DESCRIPTIONS, normalizeCapabilities } from "@/lib/mcp/permissions";
export const runtime = "nodejs";
function refuse(message: string, status = 400): Response {
  // Only application-owned literal messages belong here, never raw DB errors.
  return new Response(`<!doctype html><meta charset="utf-8"><title>Connection refused</title><main style="font-family:system-ui;max-width:34rem;margin:4rem auto;padding:0 1rem"><h1>Connection refused</h1><p>${message}</p><p>Nothing has been granted. You can close this window.</p><p><a href="/">Back to Life OS</a></p></main>`, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
export async function POST(req: Request): Promise<Response> {
  const origin = req.headers.get("origin");
  if (!origin || ![appOrigin(req), requestOrigin(req)].filter(Boolean).includes(origin)) return refuse("That request did not come from Life OS.", 403);
  let form: URLSearchParams;
  try { form = await readOAuthParams(req); }
  catch { return refuse("The approval form could not be read."); }
  const clientId = form.get("client_id") ?? "";
  const redirectUri = form.get("redirect_uri") ?? "";
  const state = form.get("state") ?? "";
  const challenge = form.get("code_challenge") ?? "";
  if (!clientId || clientId.length > 200 || redirectUri.length > 2048 || state.length > 2048 || !/^[A-Za-z0-9_-]{43}$/.test(challenge)) return refuse("This request has an invalid security challenge or connection address.");
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return refuse("Your session has expired. Sign in and start again.", 401);
  const requested: Record<string, unknown> = {};
  for (const key of Object.keys(CAPABILITY_DESCRIPTIONS)) requested[key] = form.get(key) === "on";
  for (const key of ["mailboxes", "work_streams"] as const) {
    const mode = form.get(`${key}_mode`);
    if (mode !== "all" && mode !== "selected") return refuse("Choose which accounts and work streams this connection may access.");
    requested[key] = mode === "all" ? null : form.getAll(key);
  }
  const capabilities = normalizeCapabilities(requested);
  if (!capabilities || !capabilities.read) return refuse("Select Read app records to create a connection.");
  if (capabilities.attachments && !capabilities.mail_body) return refuse("Reading attachments also requires permission to read mailbox content.");
  if (capabilities.mailboxes !== null) {
    const { data, error } = await supabase.from("accounts").select("slot").eq("user_id", user.id);
    if (error) return refuse("Account permissions could not be checked. Please retry.", 503);
    if (capabilities.mailboxes.some((slot) => !(data ?? []).some((row) => row.slot === slot))) return refuse("A selected mailbox is no longer available.");
  }
  if (capabilities.work_streams !== null) {
    const { data, error } = await supabase.from("work_streams").select("id").eq("user_id", user.id);
    if (error) return refuse("Work stream permissions could not be checked. Please retry.", 503);
    if (capabilities.work_streams.some((id) => !(data ?? []).some((row) => row.id === id))) return refuse("A selected work stream is no longer available.");
  }
  const code = newSecret();
  try {
    const { data, error } = await createServiceClient().rpc("oauth_approve_client", {
      p_user_id: user.id, p_client_id: clientId, p_redirect_uri: redirectUri,
      p_code_challenge: challenge, p_code_hash: hashSecret(code), p_capabilities: { ...capabilities },
    });
    if (error) return refuse("The approval could not be recorded. Please start the connection again.", 503);
    if (!rpcSucceeded(data)) return refuse("This registration expired, was disconnected, or has an invalid return address. Start a new connection from your application.");
  } catch { return refuse("The authorization service is unavailable. Please retry.", 503); }
  const back = new URL(redirectUri);
  back.searchParams.set("code", code);
  if (state) back.searchParams.set("state", state);
  return new Response(null, { status: 303, headers: { location: back.toString(), "cache-control": "no-store" } });
}
