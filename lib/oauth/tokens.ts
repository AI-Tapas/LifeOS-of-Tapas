import { createServiceClient } from "@/lib/supabase/service";
import { clientConfig } from "@/lib/oauth/config";
import { refreshAccessToken } from "@/lib/oauth/providers";
import { isExpired, TokenRevokedError } from "@/lib/oauth/core";
import { slotByKey } from "@/lib/accounts";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

type Svc = SupabaseClient<Database>;

interface AccountRow {
  id: string;
  user_id: string;
  slot: string | null;
  oauth_client: Database["public"]["Enums"]["oauth_client"] | null;
  status: Database["public"]["Enums"]["account_status"];
}

// Server-only. Returns a usable access token for an account: the cached one if
// still valid, otherwise a fresh one via the provider's refresh endpoint,
// persisting any rolled refresh token (Microsoft). Throws TokenRevokedError and
// flips the account to needs_reauth when the grant is gone (invalid_grant),
// which is the expected path when the ca.tapasnr password changes.
export async function getValidAccessToken(accountId: string): Promise<string> {
  const svc = createServiceClient();

  const { data: acct, error } = await svc
    .from("accounts")
    .select("id, user_id, slot, oauth_client, status")
    .eq("id", accountId)
    .single<AccountRow>();
  if (error || !acct) throw new Error("account not found");
  if (acct.status === "forwarded" || acct.status === "disconnected") {
    throw new Error(`account ${acct.slot ?? accountId} is ${acct.status}`);
  }

  const { data: toks, error: tErr } = await svc.rpc("get_account_tokens", {
    p_account_id: accountId,
  });
  if (tErr) throw tErr;
  const row = Array.isArray(toks) ? toks[0] : toks;
  if (!row?.refresh_token) {
    await markReauth(svc, acct, "no refresh token stored");
    throw new TokenRevokedError("no refresh token stored");
  }

  if (row.access_token && !isExpired(row.token_expires_at)) {
    return row.access_token;
  }

  const slot = slotByKey(acct.slot);
  if (!slot || !acct.oauth_client) {
    throw new Error(`account ${accountId} has no slot/client to refresh with`);
  }
  const cfg = clientConfig(acct.oauth_client, slot.scopes);

  try {
    const t = await refreshAccessToken(cfg, row.refresh_token);
    await svc.rpc("set_account_tokens", {
      p_account_id: accountId,
      // Microsoft rolls the refresh token; Google returns null here, so we keep
      // the stored one by passing undefined (the SQL default leaves it alone).
      p_refresh: t.refreshToken ?? undefined,
      p_access: t.accessToken,
      p_access_expires: t.expiresAt,
    });
    if (acct.status !== "connected") {
      await svc.from("accounts").update({ status: "connected" }).eq("id", accountId);
    }
    return t.accessToken;
  } catch (e) {
    if (e instanceof TokenRevokedError) {
      await markReauth(svc, acct, e.message);
    }
    throw e;
  }
}

async function markReauth(svc: Svc, acct: AccountRow, reason: string): Promise<void> {
  await svc.from("accounts").update({ status: "needs_reauth" }).eq("id", acct.id);
  await svc.from("audit_log").insert({
    user_id: acct.user_id,
    actor: "user",
    action: "oauth_refresh_failed",
    entity: "accounts",
    entity_id: acct.id,
    meta: { slot: acct.slot, reason },
  });
}
