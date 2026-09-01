import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { PageHeader } from "@/components/ui";
import NotesPanel, { type NoteRow, type NamedRow } from "@/components/brain/notes-panel";
import PeoplePanel, { type PersonRow } from "@/components/brain/people-panel";
import { sessionLine } from "@/lib/trips/bill";

export const dynamic = "force-dynamic";

type Search = Record<string, string | string[] | undefined>;

const TABS = [
  { key: "notes", label: "Notes" },
  { key: "people", label: "People" },
] as const;

// Brain was a placeholder while the assistant and both connectors were already
// writing notes and people into the database. This is the screen those rows
// have been landing in unseen.
export default async function BrainPage({
  searchParams,
}: {
  searchParams: Promise<Search>;
}) {
  const sp = await searchParams;
  const rawTab = Array.isArray(sp.tab) ? sp.tab[0] : sp.tab;
  const tab = TABS.some((t) => t.key === rawTab) ? (rawTab as string) : "notes";
  const rawPerson = Array.isArray(sp.person) ? sp.person[0] : sp.person;

  const supabase = await createClient();
  const [{ data: notes }, { data: people }, { data: streams }, { data: tasks }, { data: trips }] =
    await Promise.all([
      // ponytail: the whole note list, filtered in the browser as he types.
      // Hundreds of rows, not millions. Move the search into Postgres if this
      // read ever becomes the slow part of the page.
      supabase
        .from("notes")
        .select(
          "id, type, title, body_md, occurred_on, work_stream_id, project_id, people_ids, task_id, trip_id, created_at"
        )
        .order("created_at", { ascending: false }),
      supabase
        .from("people")
        .select("id, name, org, role, emails, phones, context_md, unverified")
        .order("name"),
      supabase.from("work_streams").select("id, name").eq("active", true).order("name"),
      // Only what a link needs: the id and something to call it.
      supabase.from("tasks").select("id, title").order("created_at", { ascending: false }),
      supabase
        .from("trips")
        .select("id, title, session_label, session_date")
        .order("start_date", { ascending: false }),
    ]);

  const taskNames: NamedRow[] = (tasks ?? []).map((t) => ({ id: t.id, name: t.title }));
  const tripNames: NamedRow[] = (trips ?? []).map((t) => {
    // The session identity leads a trip everywhere else (M7d), so it leads
    // here too rather than showing a title he would have to decode.
    const line = sessionLine(t.session_label, t.session_date);
    return { id: t.id, name: line ? `${line} - ${t.title}` : t.title };
  });
  const peopleNames: NamedRow[] = (people ?? []).map((p) => ({
    id: p.id,
    name: p.name,
  }));

  return (
    <main>
      <PageHeader
        title="Brain"
        subtitle="What you wrote down, and who you know."
      />

      <div className="mb-4 flex gap-1 rounded-xl border border-border bg-surface p-1">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === "notes" ? "/brain" : `/brain?tab=${t.key}`}
            aria-current={tab === t.key ? "page" : undefined}
            className={
              "flex min-h-11 flex-1 items-center justify-center rounded-lg text-center text-sm font-medium " +
              (tab === t.key ? "bg-accent text-white dark:text-neutral-950" : "text-secondary")
            }
          >
            {t.label}
          </Link>
        ))}
      </div>

      {tab === "notes" ? (
        <NotesPanel
          notes={(notes ?? []) as NoteRow[]}
          workStreams={(streams ?? []) as NamedRow[]}
          people={peopleNames}
          tasks={taskNames}
          trips={tripNames}
        />
      ) : (
        <PeoplePanel
          people={(people ?? []) as PersonRow[]}
          openPersonId={rawPerson}
        />
      )}
    </main>
  );
}
