import { createBrowserClient } from "@supabase/ssr";
import type { Database } from "@/lib/database.types";

export function createClient() {
  return createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      // Passkey support is experimental in supabase-js; sign-in falls back to
      // email OTP if the browser or server does not support it.
      auth: { experimental: { passkey: true } },
    }
  );
}
