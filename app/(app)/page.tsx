import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, SectionLabel } from "@/components/ui";
import NextUp, { type NextUpBands } from "@/components/home/next-up";
import {
  addDays,
  civilKey,
  civilToday,
  civilWeekday,
  formatDateIST,
  formatTimeIST,
  formatWeekdayIST,
  istInstant,
  startOfWeek,
} from "@/lib/datetime";
import { triage, needsDeadline, weekendGuard } from "@/lib/tasks/triage";
import { accountColor } from "@/lib/account-colors";

export const dynamic = "force-dynamic";

// Home answers one question: what should Tapas do next. Ranked the way he
// asked for in the persona interview (urgent and important, then important,
// then urgent), never by whoever chases loudest. The schedule and the
// approval queue sit below the answer, not above it.
export default async function DashboardPage() {
  const supabase = await createClient();
  const now = new Date();
  const nowIso = now.toISOString();
  const nowMs = now.getTime();
  const today = civilToday(nowMs);
  const dayStart = istInstant(today, 0, 0).toISOString();
  const dayEnd = istInstant(today, 23, 59).toISOString();

  const [{ data: events }, { data: tasks }, { count: pendingCount }] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, title, start_ts, all_day, accounts(slot)")
        .gte("start_ts", dayStart)
        .lte("start_ts", dayEnd)
        .order("start_ts"),
      supabase
        .from("tasks")
        .select("id, title, status, priority, due_ts, work_streams(name)")
        .in("status", ["inbox", "todo", "doing"]),
      supabase
        .from("assistant_actions")
        .select("id", { count: "exact", head: true })
        .eq("status", "proposed"),
    ]);

  type Row = NonNullable<typeof tasks>[number];
  const open = (tasks ?? []) as Row[];
  const bandsRaw = triage(open, nowMs);
  const toRow = (t: Row) => ({
    id: t.id,
    title: t.title,
    stream: (t.work_streams as { name: string } | null)?.name ?? "No stream",
    due_ts: t.due_ts,
    needs_deadline: needsDeadline(t),
  });
  const bands: NextUpBands = {
    do_first: bandsRaw.do_first.map(toRow),
    important: bandsRaw.important.map(toRow),
    urgent: bandsRaw.urgent.map(toRow),
    later_count: bandsRaw.later.length,
  };
  const inboxCount = open.filter((t) => t.status === "inbox").length;

  // Weekend guard: from Wednesday, name what is due Saturday to Monday.
  const saturday = addDays(startOfWeek(today), 5);
  const guardKeys: [string, string, string] = [
    civilKey(saturday),
    civilKey(addDays(saturday, 1)),
    civilKey(addDays(saturday, 2)),
  ];
  const weekendRisk = weekendGuard(open, civilWeekday(today), guardKeys);

  return (
    <main>
      <div className="mb-4">
        <h1 className="text-[22px] font-bold tracking-tight">
          {formatWeekdayIST(nowIso)}
        </h1>
        <p className="mt-0.5 text-sm text-neutral-500">{formatDateIST(nowIso)}</p>
      </div>

      {weekendRisk.length > 0 && (
        <div className="mb-3 rounded-xl border border-today/30 bg-today-soft p-3">
          <p className="text-sm font-medium text-today">
            Weekend at risk: {weekendRisk.length === 1 ? "a deadline lands" : `${weekendRisk.length} deadlines land`}{" "}
            between Saturday and Monday.
          </p>
          <ul className="mt-1 space-y-0.5">
            {weekendRisk.slice(0, 3).map((t) => (
              <li key={t.id} className="text-xs text-today/90">
                {t.title}, due {formatDateIST(t.due_ts!)}
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-today/80">
            Start it before Friday evening, or the weekend pays for it.
          </p>
        </div>
      )}

      {(pendingCount ?? 0) > 0 && (
        <Link
          href="/assistant?tab=queue"
          className="press mb-3 flex items-center justify-between rounded-xl border border-waiting/30 bg-waiting-soft p-3"
        >
          <span className="text-sm font-medium text-waiting">
            {pendingCount} {pendingCount === 1 ? "item is" : "items are"} waiting
            for your approval
          </span>
          <span className="text-sm text-waiting">Review</span>
        </Link>
      )}

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">Next up</h2>
          <Link href="/tasks" className="text-xs font-medium text-accent">
            All tasks
          </Link>
        </div>
        <div className="mt-2">
          <NextUp bands={bands} nowIso={nowIso} />
        </div>
      </Card>

      <Card className="mt-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">Schedule</h2>
          <Link href="/calendar" className="text-xs font-medium text-accent">
            Calendar
          </Link>
        </div>
        {events && events.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {events.map((e) => {
              const slot = (e.accounts as { slot: string | null } | null)?.slot;
              const past = !e.all_day && e.start_ts < nowIso;
              return (
                <li key={e.id} className={"flex items-center gap-3 text-sm " + (past ? "opacity-50" : "")}>
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ backgroundColor: accountColor(slot).hex }}
                    aria-hidden
                  />
                  <span className="w-16 shrink-0 text-neutral-500">
                    {e.all_day ? "All day" : formatTimeIST(e.start_ts)}
                  </span>
                  <span className="min-w-0 break-words font-medium">{e.title}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-500">
            No meetings today. A clear runway for the Do first list.
          </p>
        )}
      </Card>

      {inboxCount > 0 && (
        <Link
          href="/tasks"
          className="press mt-3 flex items-center justify-between rounded-xl border border-neutral-200 bg-white p-3 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div>
            <SectionLabel>Inbox</SectionLabel>
            <p className="mt-0.5 text-sm">
              {inboxCount} captured task{inboxCount === 1 ? "" : "s"} not yet
              sorted. Unsorted work is where things hide.
            </p>
          </div>
          <span className="text-sm font-medium text-accent">Sort</span>
        </Link>
      )}
    </main>
  );
}
