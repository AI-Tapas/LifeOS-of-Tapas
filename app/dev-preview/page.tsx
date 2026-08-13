// Local-only visual harness for layout debugging with mock data. Renders the
// real Calendar and Tasks components inside the same shell markup as the
// (app) layout, without auth or database. 404s in production.
import { notFound } from "next/navigation";
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

export default function DevPreviewPage() {
  if (process.env.NODE_ENV === "production") notFound();

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-20 pt-6">
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: calendar week</p>
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
      <TasksView tasks={tasks} projects={projects} workStreams={workStreams} />
      <Nav />
    </div>
  );
}
