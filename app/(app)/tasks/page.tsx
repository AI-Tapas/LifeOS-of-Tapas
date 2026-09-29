import { createClient } from "@/lib/supabase/server";
import TasksView, {
  type TaskRow,
  type ProjectRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";
import { loadTripSteps } from "@/lib/tasks/trip-steps";
import { isPendingInstruction } from "@/lib/tasks/agent-instructions";

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
  const supabase = await createClient();
  const now = new Date();
  const keepFrom = new Date(now.getTime() - 90 * 86400000).toISOString();
  const [{ data: tasks }, tripSteps, { data: projects }, { data: streams }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, notes, status, priority, priority_source, priority_reason, due_ts, not_before, work_stream_id, project_id, trip_id, recurring_rule, is_billable, remind_offsets, reminder_mode, agent_instructions, agent_instructions_at, agent_status, agent_result, agent_result_at, agent_done_hash"
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
        .select("id, name")
        .eq("active", true)
        .order("name"),
    ]);

  // Pending is derived on the server (it needs the hash, which the browser
  // bundle must not carry): a boolean rides down with each row.
  const rows = ((tasks ?? []) as TaskRow[])
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
        tasks={rows}
        tripSteps={tripSteps}
        projects={(projects ?? []) as ProjectRow[]}
        workStreams={(streams ?? []) as WorkStreamRow[]}
        openTaskId={rawTask}
        nowIso={now.toISOString()}
      />
    </main>
  );
}
