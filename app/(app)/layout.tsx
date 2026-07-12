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
  const { data: streams } = await supabase
    .from("work_streams")
    .select("id, name")
    .eq("active", true)
    .order("name");

  return (
    <div className="mx-auto min-h-dvh max-w-3xl px-4 pb-20 pt-6">
      <ReauthBanner />
      {children}
      <QuickAddTask workStreams={streams ?? []} />
      <Nav />
    </div>
  );
}
