import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/database.types";

// Service-role client: bypasses RLS and is the only path allowed to run the
// Vault token functions. Server-only. Never import this into a client
// component and never expose its key (SUPABASE_SERVICE_ROLE_KEY, not
// NEXT_PUBLIC_). Callers must scope every write to the authenticated user_id
// themselves, since RLS no longer does it for them.
export function createServiceClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not set");
  return createClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    key,
    { auth: { persistSession: false, autoRefreshToken: false } }
  );
}
