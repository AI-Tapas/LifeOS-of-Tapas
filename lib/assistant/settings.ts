// Per-activity model choice, made in Settings and stored in
// assistant_settings. Only the provider name and model id are stored; API
// keys stay in server-side environment variables and never reach the browser
// or the database.

import type { LlmOverride } from "./config";
import type { Database } from "@/lib/database.types";
import type { SupabaseClient } from "@supabase/supabase-js";

export type LlmRole = "chat" | "scan";

export async function loadLlmOverride(
  supabase: SupabaseClient<Database>,
  role: LlmRole
): Promise<LlmOverride | undefined> {
  const { data } = await supabase
    .from("assistant_settings")
    .select("chat_provider, chat_model, scan_provider, scan_model")
    .maybeSingle();
  if (!data) return undefined;
  return role === "chat"
    ? { provider: data.chat_provider, model: data.chat_model }
    : { provider: data.scan_provider, model: data.scan_model };
}
