import { createClient } from "@/lib/supabase/server";
import { slotByKey } from "@/lib/accounts";
import { isStale } from "@/lib/events/sync";
import {
  civilToday,
  civilKey,
  startOfWeek,
  addDays,
  istInstant,
  type CivilDate,
} from "@/lib/datetime";
import CalendarView, {
  type CalEvent,
  type CalAccount,
  type WritableAccount,
  type CalView,
} from "@/components/calendar/calendar-view";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;
function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseCivil(s: string | undefined): CivilDate {
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const [y, m, d] = s.split("-").map(Number);
    return { y, m, d };
  }
  return civilToday();
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const view = (one(sp.view) as CalView) || "week";
  const anchor = parseCivil(one(sp.date));

  // Visible span, plus a back-buffer so multi-day events that started earlier
  // are still fetched and shown.
  let viewStart: CivilDate;
  let viewEnd: CivilDate;
  if (view === "day") {
    viewStart = anchor;
    viewEnd = anchor;
  } else if (view === "month") {
    viewStart = { y: anchor.y, m: anchor.m, d: 1 };
    viewEnd = addDays({ y: anchor.y, m: anchor.m + 1, d: 1 }, -1);
  } else {
    viewStart = startOfWeek(anchor);
    viewEnd = addDays(viewStart, 6);
  }
  const queryStart = istInstant(addDays(viewStart, -31), 0, 0).toISOString();
  const queryEnd = istInstant(addDays(viewEnd, 2), 0, 0).toISOString();

  const supabase = await createClient();
  const [{ data: accounts }, { data: calendars }, { data: events }] =
    await Promise.all([
      supabase.from("accounts").select("id, slot, provider, status"),
      supabase
        .from("calendars")
        .select("id, account_id, is_primary_write, sync_enabled, last_synced_at"),
      supabase
        .from("events")
        .select(
          "id, title, description, location, start_ts, end_ts, all_day, attendees, account_id, calendar_id, source"
        )
        .gte("start_ts", queryStart)
        .lte("start_ts", queryEnd)
        .order("start_ts"),
    ]);

  const accountList: CalAccount[] = (accounts ?? []).map((a) => ({
    id: a.id,
    slot: a.slot,
    status: a.status,
    label: slotByKey(a.slot)?.label ?? a.slot ?? "Account",
  }));
  const eventList: CalEvent[] = (events ?? []).map((e) => ({
    id: e.id,
    title: e.title,
    description: e.description,
    location: e.location,
    start_ts: e.start_ts,
    end_ts: e.end_ts,
    all_day: e.all_day,
    attendees: e.attendees,
    account_id: e.account_id,
    calendar_id: e.calendar_id,
    source: e.source,
  }));

  // Writable accounts: connected, not icai (read-only), with a write-back
  // calendar chosen.
  const writeCalByAccount = new Set(
    (calendars ?? []).filter((c) => c.is_primary_write).map((c) => c.account_id)
  );
  const writable: WritableAccount[] = accountList
    .filter(
      (a) =>
        a.status === "connected" &&
        a.slot !== "icai" &&
        writeCalByAccount.has(a.id)
    )
    .map((a) => ({ id: a.id, slot: a.slot, label: a.label }));

  // Stale if any sync-enabled calendar on a connected account is overdue.
  const connectedIds = new Set(
    accountList.filter((a) => a.status === "connected").map((a) => a.id)
  );
  const syncCals = (calendars ?? []).filter(
    (c) => c.sync_enabled && connectedIds.has(c.account_id)
  );
  const stale =
    syncCals.length > 0 && syncCals.some((c) => isStale(c.last_synced_at));

  return (
    <main>
      <CalendarView
        view={view}
        anchorKey={civilKey(anchor)}
        todayKey={civilKey(civilToday())}
        events={eventList}
        accounts={accountList}
        writableAccounts={writable}
        stale={stale}
      />
    </main>
  );
}
