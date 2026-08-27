// Morning brief cron. Runs at 07:00 IST (01:30 UTC - see vercel.json).
// Mirrors Home's own queries (app/(app)/page.tsx) so the two can never rank
// differently, but through the service client, which bypasses RLS - every
// query here scopes itself to actor.userId explicitly instead of relying on
// a session (see lib/assistant/actor.ts).

import { serviceActor } from "@/lib/assistant/actor";
import { sendBriefEmail } from "@/lib/brief/send";
import { composeBrief, type BriefTask, type BriefEvent, type BriefAccountIssue } from "@/lib/brief/compose";
import { cronAuthorized, alreadyRanToday } from "@/lib/cron/guard";
import { civilKey, civilToday, istInstant } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const actor = await serviceActor();
  const { supabase, userId } = actor;
  const istDate = civilKey(civilToday());
  const appBaseUrl = process.env.APP_BASE_URL ?? "http://localhost:3000";

  const { data: recent } = await supabase
    .from("audit_log")
    .select("meta")
    .eq("user_id", userId)
    .eq("action", "cron_brief")
    .gte("ts", new Date(Date.now() - 36 * 3600 * 1000).toISOString());
  if (alreadyRanToday(recent ?? [], istDate)) {
    return Response.json({ skipped: true, reason: "already ran today" });
  }

  try {
    const today = civilToday();
    const dayStart = istInstant(today, 0, 0).toISOString();
    const dayEnd = istInstant(today, 23, 59).toISOString();

    const [{ data: tasks }, { data: streams }, { data: events }, { count: pendingCount }, { data: needsReauth }, { data: briefAccount }] =
      await Promise.all([
        supabase
          .from("tasks")
          .select("id, title, status, priority, due_ts, work_stream_id, source, created_at")
          .eq("user_id", userId)
          .in("status", ["inbox", "todo", "doing"]),
        supabase.from("work_streams").select("id, name").eq("user_id", userId),
        supabase
          .from("events")
          .select("id, title, start_ts, all_day, accounts(slot, label)")
          .eq("user_id", userId)
          .gte("start_ts", dayStart)
          .lte("start_ts", dayEnd)
          .order("start_ts"),
        supabase
          .from("assistant_actions")
          .select("id", { count: "exact", head: true })
          .eq("user_id", userId)
          .eq("status", "proposed"),
        supabase.from("accounts").select("slot, label").eq("user_id", userId).eq("status", "needs_reauth"),
        supabase
          .from("accounts")
          .select("id, email, status, connect_mode")
          .eq("user_id", userId)
          .eq("slot", "ca_tapasnr")
          .maybeSingle(),
      ]);

    const streamName = new Map((streams ?? []).map((s) => [s.id, s.name]));
    const briefTasks: BriefTask[] = (tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      due_ts: t.due_ts,
      status: t.status,
      source: t.source,
      created_at: t.created_at,
      stream: streamName.get(t.work_stream_id) ?? "No stream",
    }));
    const briefEvents: BriefEvent[] = (events ?? []).map((e) => {
      const acc = e.accounts as { slot: string | null; label: string | null } | null;
      return {
        id: e.id,
        title: e.title,
        start_ts: e.start_ts,
        all_day: e.all_day,
        account_slot: acc?.slot ?? null,
        account_label: acc?.label ?? null,
      };
    });
    const accountsNeedingReconnect: BriefAccountIssue[] = (needsReauth ?? []).map((a) => ({
      slot: a.slot ?? "unknown",
      label: a.label,
    }));

    const { subject, html, text } = composeBrief({
      nowMs: Date.now(),
      tasks: briefTasks,
      events: briefEvents,
      pendingApprovalsCount: pendingCount ?? 0,
      accountsNeedingReconnect,
      appBaseUrl,
    });

    if (!briefAccount || briefAccount.status !== "connected" || briefAccount.connect_mode !== "direct") {
      await supabase.from("audit_log").insert({
        user_id: userId,
        actor: "assistant",
        action: "cron_brief_skipped",
        entity: "cron",
        meta: { ist_date: istDate, reason: "ca_tapasnr not connected" } as Json,
      });
      return Response.json({ skipped: true, reason: "ca_tapasnr not connected" });
    }

    try {
      const sent = await sendBriefEmail(briefAccount.id, briefAccount.email, subject, html, text);
      await supabase.from("audit_log").insert({
        user_id: userId,
        actor: "assistant",
        action: "cron_brief",
        entity: "cron",
        meta: { ist_date: istDate, provider_message_id: sent.provider_message_id } as Json,
      });
      return Response.json({ ok: true, sent: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : "send failed";
      await supabase.from("audit_log").insert({
        user_id: userId,
        actor: "assistant",
        action: "cron_brief_skipped",
        entity: "cron",
        meta: { ist_date: istDate, reason: message } as Json,
      });
      return Response.json({ skipped: true, reason: message });
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : "brief failed";
    await supabase.from("audit_log").insert({
      user_id: userId,
      actor: "assistant",
      action: "cron_brief_failed",
      entity: "cron",
      meta: { ist_date: istDate, message } as Json,
    });
    return Response.json({ ok: false, error: message }, { status: 500 });
  }
}
