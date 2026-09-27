// Morning brief cron. Runs at 07:00 IST (01:30 UTC - see vercel.json).
// Mirrors Home's own queries (app/(app)/page.tsx) so the two can never rank
// differently, but through the service client, which bypasses RLS - every
// query here scopes itself to actor.userId explicitly instead of relying on
// a session (see lib/assistant/actor.ts).

import { serviceActor } from "@/lib/assistant/actor";
import { sendBriefEmail } from "@/lib/brief/send";
import { composeBrief, type BriefTask, type BriefEvent, type BriefAccountIssue } from "@/lib/brief/compose";
import { staleTripStepIds } from "@/lib/tasks/trip-rollup";
import { lapsedLine, sweepLapsed } from "@/lib/tasks/lapse";
import { ticketBriefLine } from "@/lib/trips/ticket";
import { cabBriefLine } from "@/lib/trips/cab";
import { loadTripSteps } from "@/lib/tasks/trip-steps";
import { setTaskStatus } from "@/lib/tasks/write";
import type { MonthExpense } from "@/lib/trips/month";
import type { Holding } from "@/lib/money/investments";
import { cronAuthorized, alreadyRanToday } from "@/lib/cron/guard";
import { addDays, civilKey, civilToday, istInstant } from "@/lib/datetime";
import type { Json } from "@/lib/database.types";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function GET(req: Request): Promise<Response> {
  if (!cronAuthorized(req.headers.get("authorization"))) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const actor = await serviceActor("cron_brief");
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

    const [{ data: tasks }, tripSteps, { data: streams }, { data: events }, { count: pendingCount }, { data: needsReauth }, { data: briefAccount }, { data: reminderRows }, { data: expenseRows }, { data: holdingRows }, { data: recentTripRows }] =
      await Promise.all([
        supabase
          .from("tasks")
          .select("id, title, status, priority, due_ts, not_before, lapses_on, work_stream_id, source, created_at, trip_id")
          .eq("user_id", userId)
          .in("status", ["inbox", "todo", "doing"]),
        // Trip checklist steps with their trip: the brief shows one rolled-up
        // line per trip instead of a row per step. Same loader as Home.
        loadTripSteps(supabase, userId),
        supabase.from("work_streams").select("id, name").eq("user_id", userId),
        supabase
          .from("events")
          .select("id, title, start_ts, all_day, ext_event_id, accounts(slot, label)")
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
        // The app's own reminder events; the composer drops these from the
        // Also today list so a task never appears twice in one brief.
        supabase
          .from("reminders")
          .select("ext_event_id")
          .eq("user_id", userId)
          .not("ext_event_id", "is", null),
        // Trip expenses, for the receipt-gap line the brief carries from the
        // 25th of the month onward.
        supabase
          .from("trip_expenses")
          .select("id, trip_id, category, amount, date, billable, receipt_ref")
          .eq("user_id", userId),
        // Holdings with a review date. A review writes no calendar event by
        // design (M7b), so the brief is where it reaches him.
        supabase
          .from("finance_items")
          .select("id, kind, name, institution, value, key_date, key_date_type, remind, notes")
          .eq("user_id", userId)
          .eq("key_date_type", "review")
          .not("key_date", "is", null),
        // Trips whose session or travel day was yesterday: the brief lands at
        // 7 am on exactly the recovery morning (B5). Same query Home uses.
        supabase
          .from("trips")
          .select("id, title, status, session_label, session_date, end_date, cities")
          .eq("user_id", userId)
          .or(
            `session_date.eq.${civilKey(addDays(today, -1))},end_date.eq.${civilKey(addDays(today, -1))}`
          ),
      ]);

    // B20, beside the trip-step sweep: an open task whose window closed
    // before today (lapses_on) is dropped, never deleted, in ONE undoable
    // assistant action, and the brief says how many. A task with no
    // lapses_on is never touched, however overdue.
    const lapseUndo = await sweepLapsed(
      async (id, status) => (await setTaskStatus(supabase, userId, id, status)).ok,
      tasks ?? [],
      istDate
    );
    const lapsedIds = new Set(lapseUndo.tasks.map((t) => t.id));
    if (lapsedIds.size) {
      const { data: action } = await supabase
        .from("assistant_actions")
        .insert({
          user_id: userId,
          kind: "lapse_tasks",
          mode: "auto",
          status: "executed",
          title: `${lapsedLine(lapsedIds.size)} (closed windows)`.slice(0, 200),
          payload: { task_ids: [...lapsedIds] } as Json,
          executed_at: new Date().toISOString(),
          result: { undo: lapseUndo } as unknown as Json,
        })
        .select("id")
        .single();
      await supabase.from("audit_log").insert({
        user_id: userId,
        actor: "assistant",
        action: "tasks_lapsed",
        entity: "tasks",
        entity_id: action?.id ?? null,
        meta: { ist_date: istDate, dropped: [...lapsedIds], action_id: action?.id ?? null } as Json,
      });
    }
    // Ticket emails the night's scan could not place on a trip: a count only,
    // from the scan's own audit rows. Not a task.
    const { data: scanRows } = await supabase
      .from("audit_log")
      .select("meta")
      .eq("user_id", userId)
      .eq("action", "mail_scan")
      .gte("ts", istInstant(today, 0, 0).toISOString());
    // Cities and dates only; the scan never records a PNR.
    const noTrip: { from: string; to: string; date: string }[] = [];
    const unreadable: { from: string; to: string }[] = [];
    // B21: cab rides added, by the trip's own label, and Bharat Taxi invoices
    // that could not be split. Personal rides are never read here.
    const cabAdded: { label: string; count: number; amount: number }[] = [];
    let cabUnsplit = 0;
    for (const r of scanRows ?? []) {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      for (const c of Array.isArray(meta.cab_added_by_trip) ? meta.cab_added_by_trip : []) {
        const x = (c ?? {}) as Record<string, unknown>;
        if (typeof x.label === "string" && typeof x.count === "number" && typeof x.amount === "number") {
          cabAdded.push({ label: x.label, count: x.count, amount: x.amount });
        }
      }
      if (typeof meta.cab_receipts_unsplit === "number") cabUnsplit += meta.cab_receipts_unsplit;
      for (const l of Array.isArray(meta.tickets_without_trip_legs) ? meta.tickets_without_trip_legs : []) {
        const x = (l ?? {}) as Record<string, unknown>;
        if (typeof x.from === "string" && typeof x.to === "string" && typeof x.date === "string") {
          noTrip.push({ from: x.from, to: x.to, date: x.date });
        }
      }
      for (const u of Array.isArray(meta.tickets_unreadable_routes) ? meta.tickets_unreadable_routes : []) {
        const x = (u ?? {}) as Record<string, unknown>;
        unreadable.push({ from: String(x.from ?? ""), to: String(x.to ?? "") });
      }
    }
    const housekeeping = [
      lapsedLine(lapsedIds.size),
      ticketBriefLine(noTrip, unreadable),
      cabBriefLine(cabAdded, cabUnsplit),
    ].filter(
      (l): l is string => l !== null
    );

    const streamName = new Map((streams ?? []).map((s) => [s.id, s.name]));
    const briefTasks: BriefTask[] = (tasks ?? []).filter((t) => !lapsedIds.has(t.id)).map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      due_ts: t.due_ts,
      not_before: t.not_before,
      status: t.status,
      source: t.source,
      created_at: t.created_at,
      trip_id: t.trip_id,
      stream: streamName.get(t.work_stream_id) ?? "No stream",
    }));
    // The morning sweep: a step still open days after its trip ended is not
    // owed any more, so it is dropped (never deleted, and undoable like any
    // status change) before the brief ranks it as urgent for ever.
    const stale = new Set(staleTripStepIds(tripSteps, istDate));
    for (const id of stale) await setTaskStatus(supabase, userId, id, "dropped");
    for (const s of tripSteps) if (stale.has(s.id)) s.status = "dropped";
    if (stale.size) {
      await supabase.from("audit_log").insert({
        user_id: userId,
        actor: "assistant",
        action: "trip_steps_swept",
        entity: "tasks",
        meta: { ist_date: istDate, dropped: [...stale] } as Json,
      });
    }
    const briefEvents: BriefEvent[] = (events ?? []).map((e) => {
      const acc = e.accounts as { slot: string | null; label: string | null } | null;
      return {
        id: e.id,
        title: e.title,
        start_ts: e.start_ts,
        all_day: e.all_day,
        account_slot: acc?.slot ?? null,
        account_label: acc?.label ?? null,
        ext_event_id: e.ext_event_id,
      };
    });
    const accountsNeedingReconnect: BriefAccountIssue[] = (needsReauth ?? []).map((a) => ({
      slot: a.slot ?? "unknown",
      label: a.label,
    }));

    const { subject, html, text } = composeBrief({
      nowMs: Date.now(),
      tasks: briefTasks,
      tripSteps,
      events: briefEvents,
      reminderExtEventIds: (reminderRows ?? [])
        .map((r) => r.ext_event_id)
        .filter((v): v is string => v !== null),
      tripExpenses: (expenseRows ?? []).map(
        (e): MonthExpense => ({
          id: e.id,
          trip_id: e.trip_id,
          category: e.category,
          amount: Number(e.amount),
          date: e.date,
          billable: e.billable,
          receipt_ref: e.receipt_ref,
        })
      ),
      holdings: (holdingRows ?? []) as Holding[],
      recentTrips: (recentTripRows ?? []).map((t) => ({
        id: t.id,
        title: t.title,
        status: t.status,
        session_label: t.session_label,
        session_date: t.session_date,
        end_date: t.end_date,
        // cities is jsonb, so it arrives as Json.
        cities: Array.isArray(t.cities) ? (t.cities as string[]) : [],
      })),
      pendingApprovalsCount: pendingCount ?? 0,
      accountsNeedingReconnect,
      appBaseUrl,
      housekeeping,
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
