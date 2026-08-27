// Local-only visual harness for layout debugging with mock data. Renders the
// real Calendar and Tasks components inside the same shell markup as the
// (app) layout, without auth or database. 404s in production.
import { notFound } from "next/navigation";
import Link from "next/link";
import Nav from "@/components/nav";
import CalendarView, {
  type CalAccount,
  type CalEvent,
} from "@/components/calendar/calendar-view";
import TasksView, {
  type ProjectRow,
  type TaskRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";
import NextUp, { type NextUpBands } from "@/components/home/next-up";
import Timeline from "@/components/home/timeline";
import { PendingCard } from "@/components/assistant/queue";
import MotionDemo from "./motion-demo";

// The timeline demo hangs off the real clock, so this page must not be
// prerendered at build time.
export const dynamic = "force-dynamic";

const accounts: CalAccount[] = [
  { id: "a1", slot: "taxstrategia", status: "connected", label: "Tax Strategia (Google Workspace)" },
  { id: "a2", slot: "ca_tapasnr", status: "connected", label: "ca.tapasnr@gmail.com" },
  { id: "a3", slot: "altechon", status: "connected", label: "Altechon (Microsoft 365)" },
  { id: "a4", slot: "icai", status: "connected", label: "ICAI" },
];

function ev(
  id: string,
  account: string,
  title: string,
  day: string,
  startH: number,
  endH: number,
  location: string | null = null
): CalEvent {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    id,
    title,
    description: null,
    location,
    start_ts: `${day}T${pad(startH - 6)}:30:00Z`,
    end_ts: `${day}T${pad(endH - 6)}:30:00Z`,
    all_day: false,
    attendees: null,
    account_id: account,
    calendar_id: null,
    source: "synced",
  };
}

const events: CalEvent[] = [
  ev("e1", "a1", "Tapas / Vignesh", "2026-08-10", 16, 17),
  ev("e2", "a2", "AICA Level 1 - B863 (D1) - Ahmedabad", "2026-08-11", 10, 17),
  ev("e3", "a1", "Tapas / Vignesh", "2026-08-11", 16, 17),
  ev(
    "e4",
    "a2",
    "AI Agent Workshop ft. Allie K. Miller + Mark Cuban",
    "2026-08-11",
    22,
    23,
    "Zoom https://events.alliekmiller.com/zoom"
  ),
  ev("e5", "a2", "Ranjit <> TSP | GST Discussion", "2026-08-12", 15, 15),
  ev(
    "e6",
    "a4",
    "Lecture Meeting on Insights into the current state of Indirect Taxation",
    "2026-08-12",
    18,
    19,
    "https://zoom.us/w/96672831229?tk=NVkMrHe9IawW_0bJgYdQ7uT4x1LmPqRs8vC5nE2wA6zh"
  ),
  ev("e7", "a3", "(no title)", "2026-08-12", 18, 19, "Microsoft Teams Meeting"),
];

const workStreams: WorkStreamRow[] = [
  { id: "w1", name: "ICAI" },
  { id: "w2", name: "Personal" },
];
const projects: ProjectRow[] = [];
const tasks: TaskRow[] = [
  {
    id: "t1",
    title: "File GSTR-3B for the July period including the reconciliations",
    notes: null,
    status: "todo",
    priority: "high",
    due_ts: "2026-08-12T03:30:00Z",
    work_stream_id: "w1",
    project_id: null,
    recurring_rule: "monthly:1",
    is_billable: false,
    remind_offsets: [7, 3, 1, 0],
  },
  {
    id: "t2",
    title: "recurrance test final",
    notes: null,
    status: "todo",
    priority: "medium",
    due_ts: "2026-08-14T03:30:00Z",
    work_stream_id: "w2",
    project_id: null,
    recurring_rule: "daily:1",
    is_billable: false,
    remind_offsets: [7, 3, 1, 0],
  },
];

const nextUpBands: NextUpBands = {
  do_first: [
    {
      id: "n1",
      title: "Reply to GST notice for Sunrise Traders",
      stream: "Tax Strategia",
      due_ts: "2026-08-24T04:00:00Z",
      needs_deadline: false,
    },
    {
      id: "n2",
      title: "File GSTR-3B for the July period",
      stream: "Tax Strategia",
      due_ts: "2026-08-25T04:00:00Z",
      needs_deadline: false,
    },
  ],
  important: [
    {
      id: "n3",
      title: "Form the HUF: get the stamp paper",
      stream: "Personal",
      due_ts: null,
      needs_deadline: true,
    },
    {
      id: "n4",
      title: "Book physiotherapy assessment for the back",
      stream: "Personal",
      due_ts: null,
      needs_deadline: true,
    },
  ],
  urgent: [
    {
      id: "n5",
      title: "Send the ICAI session slides to the coordinator",
      stream: "ICAI",
      due_ts: "2026-08-26T04:00:00Z",
      needs_deadline: false,
    },
  ],
  later_count: 4,
};

const pendingItem = {
  id: "p1",
  kind: "send_email",
  title: "Email to ramesh.shah@client.example: Revised engagement letter",
  created_at_label: "25 Aug 2026, 11:05 am",
  account_label: "ca_tapasnr (ca.tapasnr@gmail.com)",
  subject: "Revised engagement letter",
  body: "Dear Ramesh bhai,\n\nSharing the revised engagement letter with the scope we discussed on call. The fee stands at Rs 3,50,000 for the year.\n\nPlease sign and return by 30 August 2026.\n\nRegards,\nTapas",
  to: [{ email: "ramesh.shah@client.example", flags: ["unverified record", "first send from here"] }],
  cc: [],
};

export default async function DevPreviewPage() {
  // Hidden in production unless the local-only harness flag is set (the
  // sandbox's dev server cannot compile CSS reliably, so visual checks run
  // against npm start with ALLOW_DEV_PREVIEW=1 in .env.local; Vercel never
  // sets it).
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_DEV_PREVIEW !== "1") {
    notFound();
  }

  // Hung off the real clock so the NOW line lands mid-rail and its minute tick
  // can be watched. The next meeting starts two minutes out, so the line can be
  // seen easing to its new slot without waiting for the day to move.
  const nowMs = new Date().getTime();
  const at = (minutes: number) => new Date(nowMs + minutes * 60_000).toISOString();
  const timelineEvents = [
    { id: "tl1", title: "ICAI study circle: recent AAR rulings", start_ts: at(-150), all_day: false, slot: "icai" },
    { id: "tl2", title: "Call: Meridian Exports, notice strategy", start_ts: at(-40), all_day: false, slot: "taxstrategia" },
    { id: "tl3", title: "Review the Vraj Textiles reconciliation", start_ts: at(2), all_day: false, slot: "taxstrategia" },
    { id: "tl4", title: "Gym", start_ts: at(180), all_day: false, slot: "ca_tapasnr" },
    { id: "tl5", title: "AICA Level 1 orientation", start_ts: at(0), all_day: true, slot: "altechon" },
  ];

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-32 pt-6">
      {/* Mirrors the real shell nesting: app/(app)/template.tsx wraps the page
          content in .page-in and the bottom nav is that wrapper's SIBLING, so
          the route-change transform is never an ancestor of a fixed element.
          Keep Nav outside this div; that is the whole point of it. */}
      <div className="page-in">
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: home header</p>
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-brand-deep">
        Tuesday, 25 August 2026
      </p>
      <h1 className="mt-2.5 font-serif text-[30px] font-medium leading-tight tracking-tight text-foreground">
        Good afternoon, Tapas.
      </h1>
      <p className="mt-2.5 max-w-[34ch] text-[14.5px] text-secondary">
        2 matters need you first.{" "}
        <strong className="font-semibold text-foreground">
          Reply to GST notice for Sunrise Traders.
        </strong>
      </p>

      <div className="mt-5 rounded-2xl border border-brand/30 bg-brand-soft p-3.5">
        <p className="text-[11px] font-bold uppercase tracking-[0.14em] text-brand-deep">
          Weekend guard
        </p>
        <p className="mt-1.5 text-sm font-medium text-foreground">
          A deadline lands between Saturday and Monday.
        </p>
        <ul className="mt-1 space-y-0.5">
          <li className="text-xs text-secondary">GSTR-1 for Vraj Textiles, due 31 Aug 2026</li>
        </ul>
        <p className="mt-1.5 text-xs text-secondary">
          Start it before Friday evening, or the weekend pays for it.
        </p>
      </div>

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: home next-up (no card wrapper, per mockup)</p>
      <NextUp bands={nextUpBands} nowIso="2026-08-25T06:00:00Z" />

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: today&apos;s shape (timeline)</p>
      <div className="flex items-baseline gap-2.5">
        <h2 className="font-serif text-[19px] font-medium leading-none tracking-tight text-foreground">
          Today&apos;s shape
        </h2>
        <div className="h-px flex-1 bg-border" aria-hidden />
        <span className="text-[11px] font-bold text-muted">Calendar</span>
      </div>
      <div className="mt-3">
        <Timeline events={timelineEvents} nowIso={new Date(nowMs).toISOString()} />
      </div>

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: motion (counter roll, completion settle)</p>
      <MotionDemo />

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: home approval banner</p>
      <Link
        href="/assistant?tab=queue"
        className="press flex items-center gap-2.5 rounded-2xl border border-waiting/40 bg-waiting-soft p-3.5"
      >
        <span className="pulse-dot h-2 w-2 shrink-0 rounded-full bg-waiting" aria-hidden />
        <span className="flex-1 text-[13.5px] font-semibold text-foreground">
          1 item is waiting for your approval.
        </span>
        <span className="shrink-0 text-sm font-medium text-waiting">Review</span>
      </Link>

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: approval queue card</p>
      <PendingCard item={pendingItem} />

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: calendar week</p>
      <CalendarView
        view="week"
        anchorKey="2026-08-13"
        todayKey="2026-08-13"
        events={events}
        accounts={accounts}
        writableAccounts={[{ id: "a2", slot: "ca_tapasnr", label: "ca.tapasnr@gmail.com" }]}
        stale={false}
      />
      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: tasks</p>
      <TasksView
        tasks={tasks}
        projects={projects}
        workStreams={workStreams}
        nowIso="2026-08-25T06:00:00Z"
      />
      </div>
      <Nav queueCount={2} />
    </div>
  );
}
