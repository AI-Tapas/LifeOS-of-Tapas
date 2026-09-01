import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BandHead, SectionLabel } from "@/components/ui";
import NextUp, { type NextUpBands } from "@/components/home/next-up";
import Timeline from "@/components/home/timeline";
import {
  addDays,
  civilKey,
  civilToday,
  civilWeekday,
  formatDateIST,
  formatWeekdayLongIST,
  istHour,
  istInstant,
  startOfWeek,
} from "@/lib/datetime";
import { triage, needsDeadline, weekendGuard } from "@/lib/tasks/triage";
import {
  rollUpTrips,
  type TripRollup,
  type TripStep,
} from "@/lib/tasks/trip-rollup";
import type { PrioritySource } from "@/lib/tasks/priority";
import {
  reviewHorizonKey,
  reviewLine,
  reviewsDue,
  type Holding,
} from "@/lib/money/investments";

export const dynamic = "force-dynamic";

function greeting(hour: number): string {
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

// One honest line about the day, built from the same bands the lists below
// show: not a generated summary, just the headline count plus whichever
// do-first item leads. Quiet (null) once there is nothing left to flag.
function narrativeLine(
  bands: NextUpBands
): { lead: string; emphasis: string | null } | null {
  if (bands.do_first.length > 0) {
    const n = bands.do_first.length;
    return {
      lead: `${n} ${n === 1 ? "matter needs" : "matters need"} you first.`,
      emphasis: bands.do_first[0].title,
    };
  }
  const upcoming = bands.important.length + bands.urgent.length;
  if (upcoming > 0) {
    return {
      lead: `Nothing urgent right now. ${upcoming} task${upcoming === 1 ? "" : "s"} worth a look when you have room.`,
      emphasis: null,
    };
  }
  return null;
}

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

  // Six independent reads in parallel. The stream name is fetched as its own
  // small table and joined in memory rather than through an embedded
  // work_streams(name) select: measured against the live database, the
  // embedded join cost about 870ms where two plain queries cost about 390ms
  // in total, and this runs on the first screen of every visit.
  const [
    { data: events },
    { data: tasks },
    { data: tripStepRows },
    { data: streams },
    { count: pendingCount },
    { data: holdings },
  ] =
    await Promise.all([
      supabase
        .from("events")
        .select("id, title, start_ts, all_day, accounts(slot)")
        .gte("start_ts", dayStart)
        .lte("start_ts", dayEnd)
        .order("start_ts"),
      supabase
        .from("tasks")
        .select(
          "id, title, status, priority, priority_source, priority_reason, due_ts, work_stream_id, trip_id"
        )
        .in("status", ["inbox", "todo", "doing"]),
      // Trip checklist steps, every status, with their trip. Travel admin
      // does not stand in this list as five rows per trip; one rolled-up
      // trip line stands for it, ranked by its most urgent open step.
      supabase
        .from("tasks")
        .select("id, title, status, priority, due_ts, trip_id, trips(id, title, start_date, end_date, cities)")
        .not("trip_id", "is", null),
      supabase.from("work_streams").select("id, name"),
      supabase
        .from("assistant_actions")
        .select("id", { count: "exact", head: true })
        .eq("status", "proposed"),
      // A review date writes no calendar event by design (M7b), so if it did
      // not appear here it would be a date that quietly passes. This IS its
      // interruption, along with the morning brief.
      supabase
        .from("finance_items")
        .select("id, kind, name, institution, value, key_date, key_date_type, remind, notes")
        .eq("key_date_type", "review")
        .not("key_date", "is", null),
    ]);

  type Row = NonNullable<typeof tasks>[number];
  // Checklist steps come out of the flat list and go back in as one row per
  // trip, ranked by the step that ranks highest (lib/tasks/trip-rollup.ts).
  const open = ((tasks ?? []) as Row[]).filter((t) => !t.trip_id);
  const tripSteps: TripStep[] = (tripStepRows ?? [])
    .filter((t) => t.trips)
    .map((t) => ({
      id: t.id,
      title: t.title,
      priority: t.priority,
      due_ts: t.due_ts,
      status: t.status,
      trip: {
        ...(t.trips as NonNullable<typeof t.trips>),
        // cities is jsonb, so it arrives as Json; the rollup wants strings.
        cities: Array.isArray(t.trips!.cities) ? (t.trips!.cities as string[]) : [],
      },
    }));
  const streamName = new Map((streams ?? []).map((s) => [s.id, s.name]));

  type Ranked = Pick<Row, "id" | "title" | "priority" | "due_ts"> & {
    priority_source?: PrioritySource;
    priority_reason?: string | null;
    status: string;
    work_stream_id: string;
    rollup?: TripRollup;
  };
  const rankable: Ranked[] = [
    ...open,
    ...rollUpTrips(tripSteps, nowMs).map((r) => ({
      id: r.id,
      title: r.label,
      status: r.status,
      priority: r.priority,
      due_ts: r.due_ts,
      work_stream_id: "",
      rollup: r,
    })),
  ];

  const bandsRaw = triage(rankable, nowMs);
  const toRow = (t: Ranked) => ({
    id: t.id,
    title: t.title,
    stream: t.rollup
      ? `${t.rollup.progress}, next: ${t.rollup.next_title}`
      : (streamName.get(t.work_stream_id) ?? "No stream"),
    due_ts: t.due_ts,
    needs_deadline: t.rollup ? false : needsDeadline(t),
    trip_id: t.rollup ? t.rollup.trip_id : null,
    // Why this sits where it sits. A trip line stands for five steps, so it
    // carries no single reason of its own.
    priority_source: t.rollup ? undefined : t.priority_source,
    priority_reason: t.rollup ? null : t.priority_reason,
  });
  const bands: NextUpBands = {
    do_first: bandsRaw.do_first.map(toRow),
    important: bandsRaw.important.map(toRow),
    urgent: bandsRaw.urgent.map(toRow),
    later_count: bandsRaw.later.length,
  };
  const inboxCount = open.filter((t) => t.status === "inbox").length;
  const narrative = narrativeLine(bands);

  // Weekend guard: from Wednesday, name what is due Saturday to Monday.
  const saturday = addDays(startOfWeek(today), 5);
  const guardKeys: [string, string, string] = [
    civilKey(saturday),
    civilKey(addDays(saturday, 1)),
    civilKey(addDays(saturday, 2)),
  ];
  const weekendRisk = weekendGuard(open, civilWeekday(today), guardKeys);

  const todayKey = civilKey(today);
  const dueReviews = reviewsDue(
    (holdings ?? []) as Holding[],
    todayKey,
    reviewHorizonKey(today)
  );
  const moneyLine = reviewLine(dueReviews);

  const timelineEvents = (events ?? []).map((e) => ({
    id: e.id,
    title: e.title,
    start_ts: e.start_ts,
    all_day: e.all_day,
    slot: (e.accounts as { slot: string | null } | null)?.slot ?? null,
  }));

  return (
    <main>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-deep">
        {formatWeekdayLongIST(nowIso)}, {formatDateIST(nowIso)}
      </p>
      <h1 className="mt-2.5 font-serif text-[30px] font-medium leading-tight tracking-tight text-foreground">
        {greeting(istHour(nowIso))}, Tapas.
      </h1>
      {narrative && (
        <p className="mt-2.5 max-w-[34ch] text-[14.5px] text-secondary">
          {narrative.lead}
          {narrative.emphasis && (
            <>
              {" "}
              <strong className="font-semibold text-foreground">
                {narrative.emphasis}.
              </strong>
            </>
          )}
        </p>
      )}

      {weekendRisk.length > 0 && (
        <div className="mt-5 rounded-2xl border border-brand/30 bg-brand-soft p-3.5">
          <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-deep">
            Weekend guard
          </p>
          <p className="mt-1.5 text-sm font-medium text-foreground">
            {weekendRisk.length === 1 ? "A deadline lands" : `${weekendRisk.length} deadlines land`}{" "}
            between Saturday and Monday.
          </p>
          <ul className="mt-1 space-y-0.5">
            {weekendRisk.slice(0, 3).map((t) => (
              <li key={t.id} className="text-xs text-secondary">
                {t.title}, due {formatDateIST(t.due_ts!)}
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-xs text-secondary">
            Start it before Friday evening, or the weekend pays for it.
          </p>
        </div>
      )}

      {(pendingCount ?? 0) > 0 && (
        <Link
          href="/assistant?tab=queue"
          className="press mt-3 flex items-center gap-2.5 rounded-2xl border border-waiting/40 bg-waiting-soft p-3.5"
        >
          <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-waiting" aria-hidden />
          <span className="flex-1 text-[13.5px] font-semibold text-foreground">
            {pendingCount} {pendingCount === 1 ? "item is" : "items are"} waiting
            for your approval.
          </span>
          <span className="shrink-0 text-sm font-medium text-waiting">Review</span>
        </Link>
      )}

      {moneyLine && (
        <Link
          href="/money"
          className="press mt-3 flex items-center gap-2.5 rounded-2xl border border-border bg-surface p-3.5"
        >
          <span className="flex-1 text-[13.5px] text-foreground">{moneyLine}</span>
          <span className="shrink-0 text-sm font-medium text-accent">Money</span>
        </Link>
      )}

      <div className="mt-6">
        <NextUp bands={bands} nowIso={nowIso} />
      </div>

      <section className="mt-6">
        <BandHead
          title="Today&apos;s shape"
          action={
            <Link href="/calendar" className="text-[11px] font-bold text-muted">
              Calendar
            </Link>
          }
        />
        <div className="mt-3">
          <Timeline events={timelineEvents} nowIso={nowIso} />
        </div>
      </section>

      {inboxCount > 0 && (
        <Link
          href="/tasks"
          className="press mt-6 flex items-center justify-between rounded-xl border border-border bg-surface p-3"
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
