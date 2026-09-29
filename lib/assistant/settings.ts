// Per-activity model choice, made in Settings and stored in
// assistant_settings. Only the provider name and model id are stored; API
// keys stay in server-side environment variables and never reach the browser
// or the database.

import type { LlmOverride } from "./config";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

// B24: only the nightly mail scan uses the app's own AI key. The chat_provider
// and chat_model columns are still in the table, unread, and can be dropped
// in a later migration.
export async function loadLlmOverride(
  supabase: SupabaseClient<Database>
): Promise<LlmOverride | undefined> {
  const { data } = await supabase
    .from("assistant_settings")
    .select("scan_provider, scan_model")
    .maybeSingle();
  if (!data) return undefined;
  return { provider: data.scan_provider, model: data.scan_model };
}
