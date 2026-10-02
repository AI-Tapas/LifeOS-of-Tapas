import { createClient } from "@/lib/supabase/server";
import TasksView, {
  type TaskRow,
  type ProjectRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";
import { loadTripSteps } from "@/lib/tasks/trip-steps";
import { isPendingInstruction } from "@/lib/tasks/agent-instructions";
import { missingHoursIds, type HoursTask } from "@/lib/hours/month";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

export default async function TasksPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  // ?task=<id> opens that task's drawer, so a note referencing a task has
  // somewhere to link to. There is no page for a single task.
  const rawTask = Array.isArray(sp.task) ? sp.task[0] : sp.task;
  // B26: ?agent=needs_you (the Home line) shows only the tasks agents have
  // asked him about.
  const agentFilter = (Array.isArray(sp.agent) ? sp.agent[0] : sp.agent) === "needs_you";
  // B32: ?hours=missing (the Home line) lists this month's finished billable
  // tasks that have no hours logged.
  const hoursFilter = (Array.isArray(sp.hours) ? sp.hours[0] : sp.hours) === "missing";
  const supabase = await createClient();
  const now = new Date();
  const keepFrom = new Date(now.getTime() - 90 * 86400000).toISOString();
  const [{ data: tasks }, tripSteps, { data: projects }, { data: streams }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, notes, status, priority, priority_source, priority_reason, due_ts, completed_at, not_before, work_stream_id, project_id, trip_id, recurring_rule, is_billable, hours_spent, billable, billing_state, billing_ref, remind_offsets, reminder_mode, agent_instructions, agent_instructions_at, agent_status, agent_result, agent_result_at, agent_done_hash"
        )
        // Open work, plus what he finished in the last 90 days for the Done
        // column. The page used to load every task ever created and filter
        // in the browser, which grew slower with each week of use.
        .or(`status.in.(inbox,todo,doing),created_at.gte.${keepFrom}`)
        .order("created_at", { ascending: false }),
      // The trip behind each checklist step, so the overview can show one
      // ranked line per trip instead of five rows of travel admin.
      loadTripSteps(supabase),
      supabase
        .from("projects")
        .select("id, name, work_stream_id, status, notes")
        .order("name"),
      supabase
        .from("work_streams")
        .select("id, name, billable")
        .eq("active", true)
        .order("name"),
    ]);

  // Pending is derived on the server (it needs the hash, which the browser
  // bundle must not carry): a boolean rides down with each row.
  const streamById = new Map((streams ?? []).map((s) => [s.id, s]));
  const missingIds = hoursFilter
    ? missingHoursIds(
        ((tasks ?? []) as unknown as (TaskRow & { completed_at?: string | null })[]).map((t): HoursTask => ({
          id: t.id,
          status: t.status,
          completed_at: t.completed_at ?? null,
          hours_spent: t.hours_spent === null || t.hours_spent === undefined ? null : Number(t.hours_spent),
          billable: t.billable,
          recurring_rule: t.recurring_rule,
          trip_id: t.trip_id,
          stream_name: streamById.get(t.work_stream_id)?.name ?? "",
          stream_billable: streamById.get(t.work_stream_id)?.billable === true,
        })),
        now.getTime()
      )
    : null;
  const rows = ((tasks ?? []) as TaskRow[])
    .filter((t) => !missingIds || missingIds.has(t.id))
    .map((t) => ({ ...t, agent_pending: isPendingInstruction(t) }))
    .filter(
      (t) =>
        !agentFilter ||
        (t.agent_status === "needs_you" && ["inbox", "todo", "doing"].includes(t.status))
    );

  return (
    <main>
      <TasksView
        agentFilter={agentFilter}
        hoursFilter={hoursFilter}
        tasks={rows}
        tripSteps={tripSteps}
        projects={(projects ?? []) as ProjectRow[]}
        workStreams={(streams ?? []).map((s) => ({ id: s.id, name: s.name })) as WorkStreamRow[]}
        openTaskId={rawTask}
        nowIso={now.toISOString()}
      />
    </main>
  );
}
