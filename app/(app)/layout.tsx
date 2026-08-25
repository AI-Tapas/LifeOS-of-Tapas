import Nav from "@/components/nav";
import ReauthBanner from "@/components/reauth-banner";
import QuickAddTask from "@/components/quick-add-task";
import { createClient } from "@/lib/supabase/server";

export default async function AppLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const supabase = await createClient();
  const [{ data: streams }, { count: queueCount }] = await Promise.all([
    supabase
      .from("work_streams")
      .select("id, name")
      .eq("active", true)
      .order("name"),
    // Pending approvals surface as a dot on the Assistant tab, so a queued
    // send never waits invisibly (persona: scannable trail, no silent queue).
    supabase
      .from("assistant_actions")
      .select("id", { count: "exact", head: true })
      .eq("status", "proposed"),
  ]);

  return (
    <div className="mx-auto min-h-dvh max-w-3xl overflow-x-clip px-4 pb-32 pt-6 sm:pb-20">
      <ReauthBanner />
      {children}
      <QuickAddTask workStreams={streams ?? []} />
      <Nav queueCount={queueCount ?? 0} />
    </div>
  );
}
