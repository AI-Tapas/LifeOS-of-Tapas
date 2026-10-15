"use server";

import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { rpcSucceeded } from "@/lib/mcp/oauth-http";

export async function revokeConnectionAction(clientId: string): Promise<{ ok: boolean; message?: string }> {
  if (!clientId || clientId.length > 200) return { ok: false, message: "That connection is invalid." };
  try {
    const supabase = await createClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return { ok: false, message: "Please sign in and try again." };
    const { data, error } = await createServiceClient().rpc("oauth_disconnect_client", { p_user_id: user.id, p_client_id: clientId });
    if (error || !rpcSucceeded(data)) return { ok: false, message: "Disconnect was not confirmed. The connection may still have access. Please retry." };
    return { ok: true };
  } catch {
    return { ok: false, message: "Disconnect was not confirmed. Check your connection and retry." };
  }
}
