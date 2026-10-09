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
  istInstant,
} from "@/lib/datetime";
import { overlapsFrom } from "@/lib/events/window";
import { taskContextLines } from "./context-tasks";
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
  const todayKey = civilKey(today);

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
          "id, title, status, priority, priority_source, priority_reason, due_ts, not_before, source, created_at, work_stream_id, work_streams(name)"
        )
        .in("status", ["inbox", "todo", "doing"])
        .order("due_ts", { ascending: true, nullsFirst: false })
        .limit(30),
      supabase
        .from("events")
        .select("title, start_ts, all_day, accounts(slot)")
        .lte("start_ts", weekAhead)
        .or(overlapsFrom(istInstant(today, 0, 0).toISOString()))
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
        .or(
          `session_date.eq.${yesterdayKey},end_date.eq.${yesterdayKey},session_date.eq.${todayKey},end_date.eq.${todayKey}`
        ),
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

  // B19 and B22. Waiting tasks are named apart, mail-derived rows stay inside
  // the untrusted fence, and every row names its stream and created date.
  // The rendering is pure in context-tasks.ts; the 30-row cap is the query's.
  lines.push(
    ...taskContextLines(
      (tasks ?? []).map((t) => ({
        ...t,
        stream: (t.work_streams as { name: string } | null)?.name ?? "?",
      })),
      civilKey(today)
    )
  );

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

export interface ActivePersona {
  id: string;
  version: number;
  sections_md: string;
}

// One query for "which persona is live", so the in-app system prompt and the
// connector's house-rules tool can never disagree about which version that is.
export async function loadActivePersonaRow(
  supabase: Db
): Promise<ActivePersona | null> {
  const { data } = await supabase
    .from("assistant_persona")
    .select("id, version, sections_md")
    .eq("active", true)
    .order("version", { ascending: false })
    .limit(1)
    .maybeSingle();
  return data ?? null;
}

export async function loadActivePersona(supabase: Db): Promise<string | null> {
  return (await loadActivePersonaRow(supabase))?.sections_md ?? null;
}
