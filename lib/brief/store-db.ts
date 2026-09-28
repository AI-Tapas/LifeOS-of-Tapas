// The briefs table behind lib/brief/store.ts. Every query names the owner's
// user_id: the brief cron and the connectors reach it as service_role, which
// RLS does not scope.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";
import type { BriefStore } from "@/lib/brief/store";

export function briefStoreFor(supabase: SupabaseClient<Database>, userId: string): BriefStore {
  return {
    async upsert(row) {
      const { error } = await supabase
        .from("briefs")
        .upsert({ user_id: userId, ...row }, { onConflict: "user_id,brief_date" });
      if (error) throw new Error(`The brief could not be kept: ${error.message}`);
    },
    async deleteBefore(date) {
      await supabase.from("briefs").delete().eq("user_id", userId).lt("brief_date", date);
    },
    async latest(onOrBefore) {
      let q = supabase
        .from("briefs")
        .select("brief_date, subject, body_text, created_at")
        .eq("user_id", userId)
        .order("brief_date", { ascending: false })
        .limit(1);
      if (onOrBefore) q = q.lte("brief_date", onOrBefore);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return data?.[0] ?? null;
    },
  };
}
