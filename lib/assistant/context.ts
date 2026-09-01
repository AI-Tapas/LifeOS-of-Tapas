// App context for the assistant's system prompt: date, work streams, open
// tasks, the week's events, pending approvals. Email-derived rows are
// rendered inside the untrusted-data framing (attack A2): their titles are
// data the assistant reads, never instructions it follows.

import {
  addDays,
  civilKey,
  civilToday,
  formatDateIST,
  formatDateTimeIST,
  formatWeekdayIST,
} from "@/lib/datetime";
import { fenceUntrusted } from "./prompt";
import { streamRateLine, type StreamRate } from "@/lib/money/rates";
import {
  RECOVERY_ADVICE,
  recoveryLine,
  recoveryTrips,
  type RecoveryTrip,
} from "@/lib/health/recovery";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

type Db = SupabaseClient<Database>;

export async function buildAppContext(supabase: Db): Promise<string> {
  const now = new Date();
  const weekAhead = new Date(now.getTime() + 7 * 86400000).toISOString();
  const today = civilToday(now.getTime());
  const yesterdayKey = civilKey(addDays(today, -1));

  const [
    { data: streams },
    { data: tasks },
    { data: events },
    { data: pending },
    { data: accounts },
    { data: recentTrips },
  ] =
    await Promise.all([
      supabase
        .from("work_streams")
        .select("name, kind, active, hourly_rate")
        .order("name"),
      supabase
        .from("tasks")
        .select(
          "id, title, status, priority, priority_source, priority_reason, due_ts, source, work_stream_id, work_streams(name)"
        )
        .in("status", ["inbox", "todo", "doing"])
        .order("due_ts", { ascending: true, nullsFirst: false })
        .limit(30),
      supabase
        .from("events")
        .select("title, start_ts, all_day, accounts(slot)")
        .gte("start_ts", now.toISOString())
        .lte("start_ts", weekAhead)
        .order("start_ts")
        .limit(15),
      supabase
        .from("assistant_actions")
        .select("id, kind, title")
        .eq("status", "proposed")
        .order("created_at")
        .limit(10),
      supabase.from("accounts").select("slot, email, status"),
      // B5: whether today follows a full-day session. The model is told the
      // fact, not asked to work it out from the calendar; the same pure
      // function drives the card on Home.
      supabase
        .from("trips")
        .select("id, title, status, session_label, session_date, end_date, cities")
        .or(`session_date.eq.${yesterdayKey},end_date.eq.${yesterdayKey}`),
    ]);

  const lines: string[] = [];
  lines.push(
    `Now: ${formatWeekdayIST(now)} ${formatDateTimeIST(now)} IST.`,
    "",
    // B4: the rate is a fact the app holds, not a number the model is asked
    // to remember. streamRateLine is pure and tested in scripts/m7b.test.ts.
    streamRateLine((streams ?? []) as StreamRate[])
  );

  const recovery = recoveryLine(
    recoveryTrips(
      ((recentTrips ?? []) as (Omit<RecoveryTrip, "cities"> & { cities: unknown })[]).map(
        (t) => ({ ...t, cities: Array.isArray(t.cities) ? (t.cities as string[]) : [] })
      ),
      today
    )
  );
  if (recovery) {
    lines.push("", `${recovery} ${RECOVERY_ADVICE}`);
  }

  lines.push(
    "",
    "Connected accounts: " +
      ((accounts ?? [])
        .map((a) => `${a.slot ?? "?"} (${a.email}, ${a.status})`)
        .join("; ") || "none")
  );

  const trusted = (tasks ?? []).filter((t) => t.source !== "email");
  const fromMail = (tasks ?? []).filter((t) => t.source === "email");

  // "set by" is not decoration: a priority marked Tapas is his own judgment
  // and may never be changed, whatever the assistant now thinks. The reason
  // column is there so a rating it gave earlier can be revisited honestly.
  const rating = (t: {
    priority: string;
    priority_source: string;
    priority_reason: string | null;
  }) =>
    `${t.priority} | ${
      t.priority_source === "manual" ? "Tapas, do not change" : "assistant"
    }${t.priority_reason ? ` | ${t.priority_reason}` : ""}`;

  lines.push(
    "",
    "Open tasks (id | title | stream | priority | set by | why | due | status):"
  );
  if (!trusted.length) lines.push("  none");
  for (const t of trusted) {
    const stream = (t.work_streams as { name: string } | null)?.name ?? "?";
    lines.push(
      `  ${t.id} | ${t.title} | ${stream} | ${rating(t)} | ${
        t.due_ts ? formatDateIST(t.due_ts) : "no due date"
      } | ${t.status}`
    );
  }

  if (fromMail.length) {
    const body = fromMail
      .map(
        (t) =>
          `${t.id} | ${t.title} | ${rating(t)} | ${
            t.due_ts ? formatDateIST(t.due_ts) : "no due date"
          } | ${t.status}`
      )
      .join("\n");
    lines.push("", fenceUntrusted("tasks created from scanned email", body));
  }

  lines.push("", "Events in the next 7 days:");
  if (!events?.length) lines.push("  none synced");
  for (const e of events ?? []) {
    const slot = (e.accounts as { slot: string | null } | null)?.slot ?? "?";
    lines.push(
      `  ${e.all_day ? formatDateIST(e.start_ts) : formatDateTimeIST(e.start_ts)} | ${
        e.title
      } | ${slot}`
    );
  }

  lines.push(
    "",
    `Pending approvals in the queue: ${pending?.length ?? 0}` +
      ((pending ?? []).length
        ? " (" + (pending ?? []).map((p) => p.title || p.kind).join("; ") + ")"
        : "")
  );

  return lines.join("\n");
}

export async function loadActivePersona(supabase: Db): Promise<string | null> {
  const { data } = await supabase
    .from("assistant_persona")
    .select("sections_md")
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data?.sections_md ?? null;
}
