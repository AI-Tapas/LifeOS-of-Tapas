import { createClient } from "@/lib/supabase/server";
import TasksView, {
  type TaskRow,
  type ProjectRow,
  type WorkStreamRow,
} from "@/components/tasks/tasks-view";

export const dynamic = "force-dynamic";

export default async function TasksPage() {
  const supabase = await createClient();
  const [{ data: tasks }, { data: projects }, { data: streams }] =
    await Promise.all([
      supabase
        .from("tasks")
        .select(
          "id, title, notes, status, priority, due_ts, work_stream_id, project_id, recurring_rule, is_billable, remind_offsets"
        )
        .order("created_at", { ascending: false }),
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
        projects={(projects ?? []) as ProjectRow[]}
        workStreams={(streams ?? []) as WorkStreamRow[]}
      />
    </main>
  );
}
