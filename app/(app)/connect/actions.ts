"use server";

// Issuing the authorization code. This runs only from the consent screen,
// under the owner's own session, which is what makes the whole remote
// connector safe: a code exists only because Tapas pressed a button while
// signed in.

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import {
  CODE_TTL_MS,
  expiryFrom,
  hashSecret,
  newSecret,
  redirectUriAllowed,
} from "@/lib/mcp/oauth-core";

export interface ApproveInput {
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
}

export async function approveConnectionAction(
  input: ApproveInput
): Promise<{ ok: true; redirectTo: string } | { ok: false; message: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Please sign in and try again." };

  const svc = createServiceClient();
  const { data: client } = await svc
    .from("mcp_clients")
    .select("client_id, client_name, redirect_uris")
    .eq("client_id", input.clientId)
    .maybeSingle();
  if (!client) return { ok: false, message: "That application is not registered." };
  if (!redirectUriAllowed(input.redirectUri, client.redirect_uris)) {
    return { ok: false, message: "That return address is not registered by this application." };
  }
  if (!input.codeChallenge) {
    return { ok: false, message: "This request is missing its security challenge." };
  }

  const code = newSecret();
  const now = new Date();
  const { error } = await svc.from("mcp_grants").insert({
    user_id: user.id,
    client_id: input.clientId,
    kind: "code",
    token_hash: hashSecret(code),
    code_challenge: input.codeChallenge,
    redirect_uri: input.redirectUri,
    expires_at: expiryFrom(now, CODE_TTL_MS),
  });
  if (error) return { ok: false, message: error.message };

  await svc.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "mcp_connection_approved",
    entity: "mcp_clients",
    meta: { client_id: input.clientId, client_name: client.client_name },
  });

  const back = new URL(input.redirectUri);
  back.searchParams.set("code", code);
  if (input.state) back.searchParams.set("state", input.state);
  return { ok: true, redirectTo: back.toString() };
}

export async function revokeConnectionAction(
  clientId: string
): Promise<{ ok: boolean; message?: string }> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, message: "Please sign in and try again." };

  const svc = createServiceClient();
  const now = new Date().toISOString();
  // Kill the live credentials first, then the registration, so nothing can
  // slip through between the two statements.
  await svc
    .from("mcp_grants")
    .update({ revoked_at: now })
    .eq("user_id", user.id)
    .eq("client_id", clientId)
    .is("revoked_at", null);
  await svc.from("mcp_clients").delete().eq("user_id", user.id).eq("client_id", clientId);
  await svc.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "mcp_connection_revoked",
    entity: "mcp_clients",
    meta: { client_id: clientId },
  });
  return { ok: true };
}
