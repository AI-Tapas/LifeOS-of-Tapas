import { createClient } from "@/lib/supabase/server";
import TasksView, {
  type TaskRow,
  type ProjectRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";
import { loadTripSteps } from "@/lib/tasks/trip-steps";

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
  const supabase = await createClient();
  const now = new Date();
  const keepFrom = new Date(now.getTime() - 90 * 86400000).toISOString();
  const [{ data: tasks }, tripSteps, { data: projects }, { data: streams }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, notes, status, priority, priority_source, priority_reason, due_ts, work_stream_id, project_id, trip_id, recurring_rule, is_billable, remind_offsets, reminder_mode"
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

  return (
    <main>
      <TasksView
        tasks={(tasks ?? []) as TaskRow[]}
        tripSteps={tripSteps}
        projects={(projects ?? []) as ProjectRow[]}
        workStreams={(streams ?? []) as WorkStreamRow[]}
        openTaskId={rawTask}
        nowIso={now.toISOString()}
      />
    </main>
  );
}
