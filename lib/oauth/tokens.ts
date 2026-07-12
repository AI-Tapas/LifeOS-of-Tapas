import { createServiceClient } from "@/lib/supabase/service";
import { clientConfig } from "@/lib/oauth/config";
import { refreshAccessToken, resourceWithReauth } from "@/lib/oauth/providers";
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

interface StoredTokens {
  refresh_token: string | null;
  access_token: string | null;
  token_expires_at: string | null;
}

async function loadAccount(svc: Svc, accountId: string): Promise<AccountRow> {
  const { data, error } = await svc
    .from("accounts")
    .select("id, user_id, slot, oauth_client, status")
    .eq("id", accountId)
    .single<AccountRow>();
  if (error || !data) throw new Error("account not found");
  return data;
}

async function readTokens(svc: Svc, accountId: string): Promise<StoredTokens | undefined> {
  const { data, error } = await svc.rpc("get_account_tokens", {
    p_account_id: accountId,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  return row as StoredTokens | undefined;
}

// Refresh via the provider and persist the result, rolling Microsoft's refresh
// token. Flips the account to needs_reauth (and audit-logs) on a revoked grant,
// then rethrows TokenRevokedError.
async function refreshAndPersist(
  svc: Svc,
  acct: AccountRow,
  storedRefresh: string
): Promise<string> {
  const slot = slotByKey(acct.slot);
  if (!slot || !acct.oauth_client) {
    throw new Error(`account ${acct.id} has no slot/client to refresh with`);
  }
  const cfg = clientConfig(acct.oauth_client, slot.scopes);
  try {
    const t = await refreshAccessToken(cfg, storedRefresh);
    await svc.rpc("set_account_tokens", {
      p_account_id: acct.id,
      // Microsoft rolls the refresh token; Google returns null, so we keep the
      // stored one by passing undefined (the SQL default leaves it alone).
      p_refresh: t.refreshToken ?? undefined,
      p_access: t.accessToken,
      p_access_expires: t.expiresAt,
    });
    if (acct.status !== "connected") {
      await svc.from("accounts").update({ status: "connected" }).eq("id", acct.id);
    }
    return t.accessToken;
  } catch (e) {
    if (e instanceof TokenRevokedError) await markReauth(svc, acct, e.message);
    throw e;
  }
}

// Server-only. Returns a usable access token: the cached one if still valid by
// its clock, otherwise a fresh one. Throws TokenRevokedError (after flipping to
// needs_reauth) when the grant is gone. NOTE: a provider-side revocation kills
// the access token before its clock, so a cached token returned here can still
// 401 at the resource API; use withResourceAuth for those calls.
export async function getValidAccessToken(accountId: string): Promise<string> {
  const svc = createServiceClient();
  const acct = await loadAccount(svc, accountId);
  if (acct.status === "forwarded" || acct.status === "disconnected") {
    throw new Error(`account ${acct.slot ?? accountId} is ${acct.status}`);
  }
  const row = await readTokens(svc, accountId);
  if (!row?.refresh_token) {
    await markReauth(svc, acct, "no refresh token stored");
    throw new TokenRevokedError("no refresh token stored");
  }
  if (row.access_token && !isExpired(row.token_expires_at)) return row.access_token;
  return refreshAndPersist(svc, acct, row.refresh_token);
}

// Force a refresh regardless of the cached clock. Used when a resource API
// rejects the cached token (provider-side revocation).
async function forceRefreshAccessToken(accountId: string): Promise<string> {
  const svc = createServiceClient();
  const acct = await loadAccount(svc, accountId);
  const row = await readTokens(svc, accountId);
  if (!row?.refresh_token) {
    await markReauth(svc, acct, "no refresh token stored");
    throw new TokenRevokedError("no refresh token stored");
  }
  return refreshAndPersist(svc, acct, row.refresh_token);
}

// Run a resource API call for an account with automatic 401 recovery: try the
// cached token, and on 401 force one refresh and retry once. On a revoked grant
// or a persistent 401 the account is flipped to needs_reauth and
// TokenRevokedError is thrown. All M3 calendar/mail calls should route through
// this so they inherit the behaviour.
export async function withResourceAuth(
  accountId: string,
  request: (accessToken: string) => Promise<Response>
): Promise<Response> {
  return resourceWithReauth({
    getToken: () => getValidAccessToken(accountId),
    forceRefresh: () => forceRefreshAccessToken(accountId),
    request,
    onDead: () => markReauthById(accountId, "resource 401 after forced refresh"),
  });
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

async function markReauthById(accountId: string, reason: string): Promise<void> {
  const svc = createServiceClient();
  const acct = await loadAccount(svc, accountId);
  await markReauth(svc, acct, reason);
}
