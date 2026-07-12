"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { slotByKey } from "@/lib/accounts";
import { syncCalendars } from "@/lib/calendars";
import { TokenRevokedError } from "@/lib/oauth/core";

async function requireUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new Error("not signed in");
  return { supabase, user };
}

export type RefreshResult =
  | { ok: true; count: number }
  | { ok: false; reason: "needs_reauth" }
  | { ok: false; message: string };

// Never throws a raw error to the render. A revoked grant returns a clean
// needs_reauth result (and revalidates so the reauth banner shows); anything
// else returns a readable message instead of an opaque 500.
export async function refreshCalendarsAction(
  accountId: string
): Promise<RefreshResult> {
  const { supabase, user } = await requireUser();
  const { data: acct } = await supabase
    .from("accounts")
    .select("id, provider, status")
    .eq("id", accountId)
    .single();
  if (!acct) return { ok: false, message: "Account not found." };
  // Already revoked: send the user to Reconnect instead of a doomed resource call.
  if (acct.status === "needs_reauth") return { ok: false, reason: "needs_reauth" };
  if (acct.status !== "connected") {
    return { ok: false, message: `Account is ${acct.status}.` };
  }

  try {
    const count = await syncCalendars(acct.id, acct.provider, user.id);
    revalidatePath("/settings");
    return { ok: true, count };
  } catch (e) {
    if (e instanceof TokenRevokedError) {
      revalidatePath("/settings"); // status is now needs_reauth; banner will show
      return { ok: false, reason: "needs_reauth" };
    }
    return {
      ok: false,
      message: e instanceof Error ? e.message : "Could not refresh calendars.",
    };
  }
}

export async function disconnectAction(accountId: string): Promise<void> {
  const { supabase, user } = await requireUser();
  const { data: acct } = await supabase
    .from("accounts")
    .select("id, provider, slot")
    .eq("id", accountId)
    .single();
  if (!acct) throw new Error("account not found");

  const svc = createServiceClient();
  // Best-effort provider revoke. Google has a revoke endpoint; Microsoft has no
  // per-app programmatic revoke for delegated tokens, so we only clear locally.
  if (acct.provider === "google") {
    try {
      const { data } = await svc.rpc("get_account_tokens", { p_account_id: accountId });
      const row = Array.isArray(data) ? data[0] : data;
      const token = row?.refresh_token ?? row?.access_token;
      if (token) {
        await fetch(
          `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
          {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }
        );
      }
    } catch {
      // revocation is best-effort; clearing the stored token is what matters
    }
  }

  await svc.rpc("clear_account_tokens", { p_account_id: accountId });
  await svc.from("accounts").update({ status: "disconnected" }).eq("id", accountId);
  await svc.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "oauth_disconnected",
    entity: "accounts",
    entity_id: accountId,
    meta: { slot: acct.slot },
  });
  revalidatePath("/settings");
}

// icai.org only: declare the account forwarded (mail arrives via a Gmail filter
// into ca.tapasnr) instead of directly connected.
export async function setForwardedAction(forwarded: boolean): Promise<void> {
  const { user } = await requireUser();
  const slot = slotByKey("icai");
  if (!slot) throw new Error("unknown slot");
  const svc = createServiceClient();

  if (forwarded) {
    await svc.from("accounts").upsert(
      {
        user_id: user.id,
        slot: "icai",
        provider: "google",
        email: `forwarded@${slot.expectedDomain}`,
        oauth_client: null,
        connect_mode: "forwarded",
        status: "forwarded",
        scopes: [],
      },
      { onConflict: "user_id,slot" }
    );
    await svc.from("audit_log").insert({
      user_id: user.id,
      actor: "user",
      action: "account_forwarded",
      entity: "accounts",
      meta: { slot: "icai" },
    });
  } else {
    await svc
      .from("accounts")
      .delete()
      .eq("user_id", user.id)
      .eq("slot", "icai")
      .eq("connect_mode", "forwarded");
  }
  revalidatePath("/settings");
}

export async function setPrimaryWriteAction(
  accountId: string,
  calendarId: string
): Promise<void> {
  const { supabase } = await requireUser();
  // Clear the account's current write-back first so the partial unique index
  // (one is_primary_write per account) never trips, then set the chosen one.
  await supabase
    .from("calendars")
    .update({ is_primary_write: false })
    .eq("account_id", accountId)
    .eq("is_primary_write", true);
  await supabase
    .from("calendars")
    .update({ is_primary_write: true })
    .eq("id", calendarId);
  revalidatePath("/settings");
}

export async function setReminderHomeAction(calendarId: string): Promise<void> {
  const { supabase, user } = await requireUser();
  await supabase
    .from("calendars")
    .update({ is_reminder_home: false })
    .eq("user_id", user.id)
    .eq("is_reminder_home", true);
  // The DB trigger rejects this if the calendar is not on the ca_tapasnr account.
  const { error } = await supabase
    .from("calendars")
    .update({ is_reminder_home: true })
    .eq("id", calendarId);
  if (error) throw error;
  revalidatePath("/settings");
}
