"use server";

// Revoking a connection. Approval itself is a form post to
// /api/mcp/oauth/approve, deliberately not a client-side action, so it cannot
// be broken by a hydration failure.

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";


export async function revokeConnectionAction(
  clientId: string
): Promise<{ ok: boolean; message?: string }> {
  try {
    return await revokeConnection(clientId);
  } catch (e) {
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not disconnect it.",
    };
  }
}

async function revokeConnection(
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
