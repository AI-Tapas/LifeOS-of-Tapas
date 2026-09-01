import { createClient } from "@/lib/supabase/server";
import TasksView, {
  type TaskRow,
  type ProjectRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";
import type { TripStep } from "@/lib/tasks/trip-rollup";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const supabase = await createClient();
  const [{ data: tasks }, { data: tripStepRows }, { data: projects }, { data: streams }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, notes, status, priority, due_ts, work_stream_id, project_id, trip_id, recurring_rule, is_billable, remind_offsets"
        )
        .order("created_at", { ascending: false }),
      // The trip behind each checklist step, so the overview can show one
      // ranked line per trip instead of five rows of travel admin.
      supabase
        .from("tasks")
        .select("id, title, status, priority, due_ts, trip_id, trips(id, title, start_date, end_date, cities)")
        .not("trip_id", "is", null),
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

  return (
    <main>
      <TasksView
        tasks={(tasks ?? []) as TaskRow[]}
        tripSteps={tripSteps}
        projects={(projects ?? []) as ProjectRow[]}
        workStreams={(streams ?? []) as WorkStreamRow[]}
        nowIso={new Date().toISOString()}
      />
    </main>
  );
}
