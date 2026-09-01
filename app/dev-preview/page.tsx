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
import TripsView, { type TripRow } from "@/components/trips/trips-view";
import TripDetail, { type ExpenseRow } from "@/components/trips/trip-detail";
import MonthPack from "@/components/trips/month-pack";
import InvestmentsPanel, { type HoldingRow } from "@/components/money/investments-panel";
import ObligationsPanel, { type ObligationRow } from "@/components/money/obligations-panel";
import WorkStreamsPanel, { type WorkStreamView } from "@/components/settings/work-streams-panel";
import NotesPanel, { type NoteRow } from "@/components/brain/notes-panel";
import PeoplePanel, { type PersonRow } from "@/components/brain/people-panel";
import { RECOVERY_ADVICE, recoveryLine, recoveryTrips } from "@/lib/health/recovery";
import { parseLegs } from "@/lib/trips/core";
import type { MonthExpense, MonthTrip } from "@/lib/trips/month";
import type { TripStep } from "@/lib/tasks/trip-rollup";
import type { ChecklistRow } from "@/components/trips/trip-detail";

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
    trip_id: null,
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
    trip_id: null,
    recurring_rule: "daily:1",
    is_billable: false,
    remind_offsets: [7, 3, 1, 0],
  },
  // B3: a priority the assistant proposed, with the one line behind it. The
  // footnote under the row is the whole point, so it is in the preview.
  {
    id: "t3",
    title: "Reply to the GST notice for Sunrise Traders",
    notes: null,
    status: "todo",
    priority: "high",
    priority_source: "assistant",
    priority_reason: "statutory deadline, penalty for late filing",
    due_ts: "2026-09-02T04:00:00Z",
    work_stream_id: "w1",
    project_id: null,
    trip_id: null,
    recurring_rule: null,
    is_billable: true,
    remind_offsets: [7, 3, 1, 0],
  },
  // And the state B3 exists to fix: open tasks nobody has rated, which puts
  // the standing line on the Tasks overview.
  ...(["Chase the Bhavnagar coordinator", "Renew the office broadband", "Read the circular on ITC"].map(
    (title, i) => ({
      id: `u${i}`,
      title,
      notes: null,
      status: "todo" as const,
      priority: "medium" as const,
      due_ts: null,
      work_stream_id: "w2",
      project_id: null,
      trip_id: null,
      recurring_rule: null,
      is_billable: false,
      remind_offsets: [7, 3, 1, 0],
    })
  )),
];

const nextUpBands: NextUpBands = {
  do_first: [
    {
      id: "trip:t1",
      title: "AICA session, Rajkot branch, 3 to 4 September 2026",
      stream: "2 of 4 done, next: Book onward ticket",
      due_ts: "2026-08-20T04:00:00Z",
      needs_deadline: false,
      trip_id: "t1",
    },
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
      priority_source: "assistant",
      priority_reason: "statutory deadline, penalty for late filing",
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
      priority_source: "assistant",
      priority_reason: "open since March, and he asked for his health to be treated as priority",
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

// B10: an autonomous action whose target did not resolve. Nothing was done, so
// the card offers no approval, only Dismiss.
const unresolvedItem = {
  id: "p2",
  kind: "update_task",
  title: 'The task "7b3c1d9e-0000-0000-0000-000000000000" could not be resolved, so nothing was done.',
  created_at_label: "1 Sept 2026, 9:12 am",
  account_label: "unknown account",
  unresolved_reason:
    'The task "7b3c1d9e-0000-0000-0000-000000000000" could not be resolved, so nothing was done.',
};

// --- Travel Desk fixtures (M6) ---------------------------------------------
const trips: TripRow[] = [
  {
    id: "t1",
    purpose: "aica",
    title: "AICA session, Rajkot branch",
    work_stream_id: "w1",
    start_date: "2026-09-03",
    end_date: "2026-09-04",
    cities: ["Rajkot"],
    status: "planned",
    bills_to: "icai_monthly",
    session_label: "L1D2",
    session_date: "2026-09-04",
    notes: null,
    stream_name: "ICAI",
    billable_total: 6550,
    expense_count: 5,
    receipts_missing: 2,
    checklist_done: 2,
    checklist_total: 4,
  },
  {
    id: "t2",
    purpose: "aica",
    title: "AICA session, Surat branch",
    work_stream_id: "w1",
    start_date: "2026-09-07",
    end_date: "2026-09-08",
    cities: ["Surat"],
    status: "planned",
    bills_to: "icai_monthly",
    session_label: "L2D5",
    session_date: "2026-09-10",
    notes: null,
    stream_name: "ICAI",
    billable_total: 0,
    expense_count: 0,
    receipts_missing: 0,
    checklist_done: 0,
    checklist_total: 4,
  },
  {
    id: "t3",
    purpose: "conference",
    title: "GST conclave, Mumbai",
    work_stream_id: "w2",
    start_date: "2026-10-15",
    end_date: "2026-10-16",
    cities: ["Mumbai"],
    status: "planned",
    bills_to: "none",
    session_label: null,
    session_date: null,
    notes: null,
    stream_name: "Tax Strategia",
    billable_total: 0,
    expense_count: 0,
    receipts_missing: 0,
    checklist_done: 0,
    checklist_total: 0,
  },
  {
    id: "t5",
    purpose: "aica",
    title: "AICA session, Dubai chapter",
    work_stream_id: "w1",
    start_date: "2026-05-24",
    end_date: "2026-05-25",
    cities: ["Dubai"],
    status: "done",
    bills_to: "chapter_aed",
    session_label: "L2D5",
    session_date: "2026-05-18",
    notes: null,
    stream_name: "ICAI",
    billable_total: 41000,
    expense_count: 2,
    receipts_missing: 0,
    checklist_done: 4,
    checklist_total: 5,
  },
  {
    id: "t4",
    purpose: "aica",
    title: "AICA session, Bhavnagar branch",
    work_stream_id: "w1",
    start_date: "2026-05-17",
    end_date: "2026-05-19",
    cities: ["Bhavnagar"],
    status: "billed",
    bills_to: "icai_monthly",
    session_label: "L1D1",
    session_date: "2026-09-17",
    notes: null,
    stream_name: "ICAI",
    billable_total: 6550,
    expense_count: 5,
    receipts_missing: 2,
    checklist_done: 4,
    checklist_total: 4,
  },
];

// A part-done checklist with one overdue step, which is the case that must
// drag the whole trip line into the top band rather than hiding in a folder.
// Fixed clock for these screens: 25 August 2026.
const rajkot = {
  id: "t1",
  title: "AICA session, Rajkot branch",
  start_date: "2026-09-03",
  end_date: "2026-09-04",
  cities: ["Rajkot"],
};

const tripSteps: TripStep[] = [
  { id: "c1", title: "Book onward ticket", priority: "medium", due_ts: "2026-08-20T04:00:00Z", status: "todo", trip: rajkot },
  { id: "c2", title: "Book return ticket", priority: "medium", due_ts: "2026-08-27T04:00:00Z", status: "done", trip: rajkot },
  { id: "c3", title: "Confirm hotel with the branch", priority: "medium", due_ts: "2026-08-29T04:00:00Z", status: "done", trip: rajkot },
  { id: "c4", title: "Collect and keep travel receipts", priority: "medium", due_ts: "2026-09-04T04:00:00Z", status: "todo", trip: rajkot },
];

// Travel admin does not interrupt him on the calendar (M7a), so the harness
// shows the state a real trip is in.
const tripChecklist: ChecklistRow[] = [
  { id: "c1", title: "Book onward ticket", notes: null, status: "done", due_ts: "2026-05-10T04:00:00Z", reminder_mode: "in_app" },
  { id: "c2", title: "Book return ticket", notes: null, status: "done", due_ts: "2026-05-10T04:00:00Z", reminder_mode: "in_app" },
  { id: "c3", title: "Confirm hotel with the branch", notes: null, status: "done", due_ts: "2026-05-12T04:00:00Z", reminder_mode: "in_app" },
  { id: "c4", title: "Collect and keep travel receipts", notes: null, status: "todo", due_ts: "2026-05-19T04:00:00Z", reminder_mode: "in_app" },
];

const tripExpenses: ExpenseRow[] = [
  { id: "x1", category: "transport", amount: 1240, date: "2026-05-17", billable: true, receipt_ref: "physical file" },
  { id: "x2", category: "transport", amount: 1310, date: "2026-05-19", billable: true, receipt_ref: null },
  { id: "x3", category: "hotel", amount: 3200, date: "2026-05-17", billable: true, receipt_ref: "May folder" },
  { id: "x4", category: "per_diem", amount: 800, date: "2026-05-18", billable: true, receipt_ref: null },
  { id: "x5", category: "other", amount: 450, date: "2026-05-18", billable: false, receipt_ref: null },
];

// Month pack fixtures: one claimed trip, one overseas chapter trip that must
// be excluded, and a receipt gap.
const monthTrips: MonthTrip[] = [
  {
    id: "t4",
    title: "AICA session, Bhavnagar branch",
    start_date: "2026-05-17",
    end_date: "2026-05-19",
    cities: ["Bhavnagar"],
    bills_to: "icai_monthly",
    legs: [
      { from: "Ahmedabad", to: "Bhavnagar", date: "2026-05-17", mode: "vande_bharat", cost: 1240 },
      { from: "Bhavnagar", to: "Ahmedabad", date: "2026-05-19", mode: "tejas", cost: 1310 },
    ],
  },
  {
    id: "t5",
    title: "AICA session, Dubai chapter",
    start_date: "2026-05-24",
    end_date: "2026-05-25",
    cities: ["Dubai"],
    bills_to: "chapter_aed",
    legs: [],
  },
];

const monthExpenses: MonthExpense[] = tripExpenses.map((e) => ({
  ...e,
  trip_id: "t4",
}));

const tripLegs = parseLegs([
  { from: "Ahmedabad", to: "Bhavnagar", date: "2026-05-17", mode: "vande_bharat", cost: 1240 },
  { from: "Bhavnagar", to: "Ahmedabad", date: "2026-05-19", mode: "tejas", cost: 1310 },
]);

// Money fixtures: a crore-scale fund so the Indian grouping is visible, an
// FD maturing (calendar), a stock under review (in-app), and one holding
// with no date at all.
const holdings: HoldingRow[] = [
  {
    id: "h1",
    kind: "fd",
    name: "HDFC FD, 3 years",
    institution: "HDFC, Navrangpura",
    value: 1500000,
    key_date: "2026-09-12",
    key_date_type: "maturity",
    remind: true,
    notes: null,
  },
  {
    id: "h2",
    kind: "mf",
    name: "Parag Parikh Flexi Cap",
    institution: "PPFAS",
    value: 12000000,
    key_date: "2026-09-20",
    key_date_type: "review",
    remind: true,
    notes: null,
  },
  {
    id: "h3",
    kind: "stock",
    name: "Direct equity",
    institution: "Zerodha",
    value: 750000,
    key_date: "2026-11-02",
    key_date_type: "review",
    remind: true,
    notes: null,
  },
  {
    id: "h4",
    kind: "ncd",
    name: "Muthoot NCD",
    institution: null,
    value: null,
    key_date: null,
    key_date_type: null,
    remind: false,
    notes: "Value not updated since 2024",
  },
];

const obligations: ObligationRow[] = [
  {
    id: "o1",
    name: "Electricity, Torrent",
    category: "electricity",
    amount: null,
    variable_amount: true,
    frequency: "monthly",
    due_day: 12,
    due_month: null,
    interval_rule: null,
    anchor_date: null,
    autopay: true,
    account_ref: "Torrent, Bodakdev",
    active: true,
    notes: null,
    remind_offsets: [7, 3, 1, 0],
  },
  {
    id: "o2",
    name: "Water tanker",
    category: "other",
    amount: 1800,
    variable_amount: false,
    frequency: "custom",
    due_day: null,
    due_month: null,
    interval_rule: "weekly:2",
    anchor_date: "2026-08-28",
    autopay: false,
    account_ref: null,
    active: true,
    notes: null,
    remind_offsets: [1, 0],
  },
  {
    id: "o3",
    name: "Term insurance premium",
    category: "insurance",
    amount: 48000,
    variable_amount: false,
    frequency: "yearly",
    due_day: 15,
    due_month: 4,
    interval_rule: null,
    anchor_date: null,
    autopay: false,
    account_ref: null,
    active: true,
    notes: null,
    remind_offsets: [28, 7, 1, 0],
  },
];

const rateStreams: WorkStreamView[] = [
  {
    id: "w1",
    name: "ICAI",
    kind: "training",
    billing_entity: "Tapas N Ruparelia",
    feeds_billing: true,
    hourly_rate: 3500,
  },
  {
    id: "w2",
    name: "Tax Strategia",
    kind: "tax_advisory",
    billing_entity: "Tax Strategia",
    feeds_billing: true,
    hourly_rate: 12000,
  },
  {
    id: "w3",
    name: "Personal",
    kind: "personal",
    billing_entity: null,
    feeds_billing: false,
    hourly_rate: null,
  },
];

const brainPeople: PersonRow[] = [
  {
    id: "p1",
    name: "Rakesh Mehta",
    org: "ICAI Bhavnagar branch",
    role: "Branch chairman",
    emails: ["rakesh.mehta@example.org"],
    phones: [],
    context_md: "Runs the Level 1 batch in Bhavnagar and arranges the hotel there.",
    unverified: false,
  },
  {
    id: "p2",
    name: "Sunrise Traders, accounts",
    org: "Sunrise Traders",
    role: null,
    emails: ["accounts@sunrise.example"],
    phones: [],
    context_md: null,
    unverified: true,
  },
];

const brainNotes: NoteRow[] = [
  {
    id: "n1",
    type: "meeting",
    title: "Bhavnagar branch call",
    body_md:
      "Mehta will confirm the hotel by the 12th. Level 1 batch shifts to the second week of October, so the L2 dates move with it.",
    occurred_on: "2026-08-24",
    work_stream_id: "w1",
    project_id: null,
    people_ids: ["p1"],
    task_id: null,
    trip_id: "t4",
    created_at: "2026-08-24T12:00:00.000Z",
  },
  {
    id: "n2",
    type: "decision",
    title: "GST position on works contracts",
    body_md:
      "Sticking with the composite supply reading until the circular is withdrawn. To be verified against the September circular.",
    occurred_on: null,
    work_stream_id: "w2",
    project_id: null,
    people_ids: ["p2"],
    task_id: "t1",
    trip_id: null,
    created_at: "2026-08-20T09:30:00.000Z",
  },
  {
    id: "n3",
    type: "idea",
    title: "Quarterly GST digest",
    body_md: "One page a quarter, sent to the branches. Reuses the batch material.",
    occurred_on: null,
    work_stream_id: null,
    project_id: null,
    people_ids: [],
    task_id: null,
    trip_id: null,
    created_at: "2026-08-11T06:00:00.000Z",
  },
];

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
          Recovery day
        </p>
        <p className="mt-1.5 text-sm font-medium text-foreground">
          {recoveryLine(
            recoveryTrips(
              [
                {
                  id: "t4",
                  title: "AICA session, Bhavnagar branch",
                  status: "done",
                  session_label: "L1D2",
                  session_date: "2026-08-24",
                  end_date: "2026-08-25",
                  cities: ["Bhavnagar"],
                },
              ],
              { y: 2026, m: 8, d: 25 }
            )
          )}
        </p>
        <p className="mt-1.5 text-xs text-secondary">{RECOVERY_ADVICE}</p>
      </div>

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

      <p className="mb-4 mt-8 rounded bg-amber-100 p-1 text-center text-xs">dev preview: downgraded action card (B10)</p>
      <PendingCard item={unresolvedItem} />

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
        tripSteps={tripSteps}
        projects={projects}
        workStreams={workStreams}
        nowIso="2026-08-25T06:00:00Z"
      />
      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: trips overview</p>
      <TripsView
        trips={trips}
        workStreams={workStreams}
        todayKey="2026-08-25"
        receiptGapCount={2}
        receiptGapMonths={["2026-08", "2026-07"]}
      />

      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: trip detail</p>
      <TripDetail
        trip={{
          id: "t4",
          purpose: "aica",
          title: "AICA session, Bhavnagar branch",
          work_stream_id: "w1",
          start_date: "2026-05-17",
          end_date: "2026-05-19",
          cities: ["Bhavnagar"],
          status: "done",
          bills_to: "icai_monthly",
          hotel_arrangement: "branch",
          notes: null,
        }}
        streamName="ICAI"
        legs={tripLegs}
        checklist={tripChecklist}
        expenses={tripExpenses}
        workStreams={workStreams}
        todayKey="2026-08-25"
      />

      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: month pack</p>
      <MonthPack
        trips={monthTrips}
        expenses={monthExpenses}
        defaultMonth="2026-05"
        maxMonth="2026-08"
      />

      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: money, investments (M7b)</p>
      <InvestmentsPanel holdings={holdings} todayKey="2026-09-01" />

      <div className="mt-8">
        <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: money, obligations with a sub-monthly series (B2)</p>
        <ObligationsPanel obligations={obligations} todayKey="2026-09-01" />
      </div>

      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: settings, rate per work stream (B4)</p>
      <WorkStreamsPanel streams={rateStreams} />

      <hr className="my-8" />
      <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: brain, notes with followable references (M7c)</p>
      <NotesPanel
        notes={brainNotes}
        workStreams={workStreams}
        people={brainPeople.map((p) => ({ id: p.id, name: p.name }))}
        tasks={[{ id: "t1", name: "File GSTR-1 for Vraj Textiles" }]}
        trips={[{ id: "t4", name: "L1D2 - 18 May - AICA session, Bhavnagar branch" }]}
      />

      <div className="mt-8">
        <p className="mb-4 rounded bg-amber-100 p-1 text-center text-xs">dev preview: brain, people with an unverified record (M7c)</p>
        <PeoplePanel people={brainPeople} />
      </div>

      </div>
      <Nav queueCount={2} />
    </div>
  );
}
