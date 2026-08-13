import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { Card, PageHeader } from "@/components/ui";
import { formatDateIST, formatTimeIST, istDayKey, istInstant } from "@/lib/datetime";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = await createClient();
  const nowIso = new Date().toISOString();
  const [y, m, d] = istDayKey(nowIso).split("-").map(Number);
  const dayStart = istInstant({ y, m, d }, 0, 0).toISOString();
  const dayEnd = istInstant({ y, m, d }, 23, 59).toISOString();

  const [{ data: events }, { data: tasks }] = await Promise.all([
    supabase
      .from("events")
      .select("id, title, start_ts, all_day")
      .gte("start_ts", dayStart)
      .lte("start_ts", dayEnd)
      .order("start_ts"),
    supabase
      .from("tasks")
      .select("id, title, due_ts, status")
      .in("status", ["inbox", "todo", "doing"])
      .not("due_ts", "is", null)
      .lte("due_ts", dayEnd)
      .order("due_ts"),
  ]);

  const overdue = (tasks ?? []).filter((t) => t.due_ts! < nowIso && istDayKey(t.due_ts!) !== istDayKey(nowIso));
  const dueToday = (tasks ?? []).filter((t) => istDayKey(t.due_ts!) === istDayKey(nowIso));

  return (
    <main>
      <PageHeader title="Today" subtitle={formatDateIST(nowIso)} />

      <Card>
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">Schedule</h2>
          <Link href="/calendar" className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
            Calendar
          </Link>
        </div>
        {events && events.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {events.map((e) => (
              <li key={e.id} className="flex gap-3 text-sm">
                <span className="w-16 shrink-0 text-neutral-500">
                  {e.all_day ? "All day" : formatTimeIST(e.start_ts)}
                </span>
                <span className="min-w-0 break-words font-medium">{e.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">Nothing scheduled today.</p>
        )}
      </Card>

      <Card className="mt-3">
        <div className="flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-neutral-500">Tasks</h2>
          <Link href="/tasks" className="text-xs font-medium text-indigo-600 dark:text-indigo-400">
            All tasks
          </Link>
        </div>
        {overdue.length + dueToday.length > 0 ? (
          <ul className="mt-2 space-y-2">
            {overdue.map((t) => (
              <li key={t.id} className="flex gap-3 text-sm">
                <span className="w-16 shrink-0 font-medium text-red-600">Overdue</span>
                <span className="min-w-0 break-words">{t.title}</span>
              </li>
            ))}
            {dueToday.map((t) => (
              <li key={t.id} className="flex gap-3 text-sm">
                <span className="w-16 shrink-0 text-neutral-500">
                  {formatTimeIST(t.due_ts!)}
                </span>
                <span className="min-w-0 break-words">{t.title}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">Nothing due today.</p>
        )}
      </Card>
    </main>
  );
}
