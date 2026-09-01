"use server";

import { revalidatePath } from "next/cache";
import { createServiceClient } from "@/lib/supabase/service";
import { slotByKey } from "@/lib/accounts";
import { syncCalendars } from "@/lib/calendars";
import { TokenRevokedError } from "@/lib/oauth/core";
import { providerOptions } from "@/lib/assistant/config";
import { requireUser } from "@/lib/auth/require-user";
import { sweepInAppReminderEvents } from "@/lib/reminders/writer";
import { reportable, describeError, recordEvent } from "@/lib/errors";

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
  const { supabase, user } = await requireUser("/settings");
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
  const { supabase, user } = await requireUser("/settings");
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
  const { user } = await requireUser("/settings");
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
  const { supabase } = await requireUser("/settings");
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
  const { supabase, user } = await requireUser("/settings");
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

// M3: choose which calendars the unified view syncs. Defaults to true for a
// newly discovered calendar; this lets the user turn a noisy calendar off.
export async function setCalendarSyncAction(
  calendarId: string,
  enabled: boolean
): Promise<void> {
  const { supabase } = await requireUser("/settings");
  await supabase
    .from("calendars")
    .update({ sync_enabled: enabled })
    .eq("id", calendarId);
  revalidatePath("/settings");
}

// ---------------------------------------------------------------------------
// M4: assistant persona. Owner-session only; the model and the mail scanner
// hold no persona tool, so these server actions are the ONLY write path
// (attack A9). Edits create a NEW version, never overwrite.
// ---------------------------------------------------------------------------
export async function savePersonaVersionAction(
  sectionsMd: string
): Promise<{ ok: boolean; message?: string; version?: number }> {
  const { supabase, user } = await requireUser("/settings");
  const text = sectionsMd.trim();
  if (!text) return { ok: false, message: "The persona cannot be empty." };

  const { data: latest } = await supabase
    .from("assistant_persona")
    .select("version")
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  const version = (latest?.version ?? 0) + 1;

  await supabase
    .from("assistant_persona")
    .update({ active: false })
    .eq("active", true);
  const { error } = await supabase.from("assistant_persona").insert({
    user_id: user.id,
    version,
    sections_md: text,
    source: "edited",
    active: true,
  });
  if (error) return { ok: false, message: error.message };
  await supabase.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "persona_new_version",
    entity: "assistant_persona",
    meta: { version },
  });
  revalidatePath("/settings");
  return { ok: true, version };
}

export async function activatePersonaVersionAction(
  personaId: string
): Promise<{ ok: boolean; message?: string }> {
  return reportable(async () => {
    // Marks that the action was reached at all. Three fixes have been aimed at
    // this path while the audit log stayed empty, which could mean the action
    // fails silently or that it never runs. This distinguishes the two.
    await recordEvent("persona_activate_entered", `id ${personaId}`);
    const { supabase, user } = await requireUser("/settings");
    await recordEvent("persona_activate_session_ok", `user ${user.id}`);

    // Every step reports its own outcome. This used to swallow the result of
    // the first update and ignore whether the row was actually found, so a
    // permission or lookup failure surfaced as a blank server error rather
    // than a sentence naming what went wrong.
    const cleared = await supabase
      .from("assistant_persona")
      .update({ active: false })
      .eq("active", true)
      .select("id");
    if (cleared.error) {
      return {
        ok: false,
        message: `Could not stand down the current version: ${describeError(cleared.error)}`,
      };
    }

    const { data, error } = await supabase
      .from("assistant_persona")
      .update({ active: true, updated_at: new Date().toISOString() })
      .eq("id", personaId)
      .select("version");
    if (error) {
      return { ok: false, message: `Could not activate: ${describeError(error)}` };
    }
    if (!data?.length) {
      return {
        ok: false,
        message:
          "That version was not found, or your account is not allowed to change it. Nothing was altered.",
      };
    }

    const logged = await supabase.from("audit_log").insert({
      user_id: user.id,
      actor: "user",
      action: "persona_activated",
      entity: "assistant_persona",
      entity_id: personaId,
      meta: { version: data[0].version },
    });
    if (logged.error) {
      // The activation itself succeeded; say so rather than implying failure.
      return {
        ok: true,
        message: `Version ${data[0].version} is active, but the audit entry failed: ${describeError(logged.error)}`,
      };
    }

    revalidatePath("/settings");
    return { ok: true };
  }) as Promise<{ ok: boolean; message?: string }>;
}

// ---------------------------------------------------------------------------
// M4: which model runs which activity. Names only; API keys stay in the
// server environment and are never written to, or read from, the database.
// ---------------------------------------------------------------------------
export async function saveAssistantModelsAction(input: {
  chat_provider: string;
  chat_model: string;
  scan_provider: string;
  scan_model: string;
}): Promise<{ ok: boolean; message?: string }> {
  const { supabase, user } = await requireUser("/settings");
  const known = new Set(providerOptions().map((o) => o.name));
  const clean = (v: string) => {
    const t = v.trim();
    return t ? t : null;
  };
  for (const p of [input.chat_provider, input.scan_provider]) {
    if (p.trim() && !known.has(p.trim())) {
      return { ok: false, message: `Unknown provider: ${p}` };
    }
  }
  const { error } = await supabase.from("assistant_settings").upsert(
    {
      user_id: user.id,
      chat_provider: clean(input.chat_provider),
      chat_model: clean(input.chat_model),
      scan_provider: clean(input.scan_provider),
      scan_model: clean(input.scan_model),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" }
  );
  if (error) return { ok: false, message: error.message };
  await supabase.from("audit_log").insert({
    user_id: user.id,
    actor: "user",
    action: "assistant_models_changed",
    entity: "assistant_settings",
    meta: {
      chat: clean(input.chat_provider),
      scan: clean(input.scan_provider),
    },
  });
  revalidatePath("/settings");
  revalidatePath("/assistant");
  return { ok: true };
}


// ---------------------------------------------------------------------------
// M7a one-off maintenance: clear the calendar entries the routine tasks no
// longer need.
// ---------------------------------------------------------------------------
// The migration switched roughly thirty checklist steps and the monthly
// invoice task to in_app, but SQL cannot delete a Google Calendar event, so
// the events they already wrote are still standing. This walks every in_app
// task whose reminders row still holds an ext_event_id and removes the event
// through the normal removeReminder path.
//
// Owner session only, reached from a button in Settings. It is deliberately
// on no tool surface, and nothing runs it automatically on deploy. Safe to
// run twice: the second run finds nothing left to clear.
export async function clearInAppCalendarEntriesAction(): Promise<{
  ok: boolean;
  cleared?: number;
  skipped?: number;
  message?: string;
}> {
  const { supabase, user } = await requireUser("/settings");
  try {
    const { cleared, skipped } = await sweepInAppReminderEvents(user.id);
    await supabase.from("audit_log").insert({
      user_id: user.id,
      actor: "user",
      action: "reminder_cleanup_run",
      entity: "reminders",
      meta: { cleared, skipped },
    });
    revalidatePath("/settings");
    return { ok: true, cleared, skipped };
  } catch (e) {
    if (e instanceof TokenRevokedError) {
      revalidatePath("/settings");
      return {
        ok: false,
        message: "Reconnect ca.tapasnr first: the calendar could not be reached.",
      };
    }
    return { ok: false, message: describeError(e) };
  }
}
